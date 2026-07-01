import { render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrollbackMessage, WhoisBundle } from "../lib/api";
import { activeAudio, closeAudio } from "../lib/audioPlayer";
import { closeMediaViewer, mediaViewerState } from "../lib/mediaViewer";

// Review fix (2026-06-11): same-host NON-media links delegate plain
// clicks to the shared iOS-standalone escape handler. The handler's
// escaping branch calls window.location.assign (unforgeable AND
// unimplemented in jsdom), so the boundary is mocked; decision logic
// is pinned in platform.test.ts, this file pins the WIRING. Everything
// else from lib/platform stays real.
const mockMaybeEscapePwaClick = vi.fn((e: MouseEvent, _href: string): boolean => {
  e.preventDefault();
  return true;
});
vi.mock("../lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/platform")>();
  return {
    ...actual,
    maybeEscapePwaClick: (e: MouseEvent, href: string) => mockMaybeEscapePwaClick(e, href),
  };
});

// C5.0 — JOIN-self auto-focus-switch: mock selection so we can assert
// setSelectedChannel is called when own nick's JOIN event shows up.
const mockSetSelectedChannel = vi.fn();
const mockSetCursorIfAdvances = vi.fn();
vi.mock("../lib/selection", () => ({
  setSelectedChannel: (ch: unknown) => mockSetSelectedChannel(ch),
  selectedChannel: () => null,
  setCursorIfAdvances: (slug: unknown, channel: unknown, id: unknown) =>
    mockSetCursorIfAdvances(slug, channel, id),
  applySeedEnvelope: vi.fn(),
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
// UX-4 bucket K — `isDocumentVisible` is a Solid signal in the real
// module; tests drive false↔true transitions via this seam so the
// `scrollToActivation` visibility-trigger effect fires deterministically.
const [docVisible, setDocVisible] = createSignal<boolean>(true);

vi.mock("../lib/documentVisibility", () => ({
  isDocumentVisible: () => docVisible(),
}));

// Send-relatch (2026-06-09): `lastOwnSend` is a signal in the real
// module set by `sendMessage` to the channel-key of THIS device's own
// send. ScrollbackPane reads it to hide the frozen marker on a focused
// send. Signal-backed stand-in mirrors the reactive contract;
// `pushOwnSend` is the test verb that fires a send.
// `equals: false` mirrors production — `lastOwnSend` is an EVENT signal,
// so a repeat send to the SAME channel must still notify (Object.is dedup
// would otherwise drop it and the marker wouldn't re-hide).
const [ownSend, setOwnSend] = createSignal<string | null>(null, { equals: false });
const pushOwnSend = (key: string) => setOwnSend(key);
vi.mock("../lib/scrollback", () => ({
  scrollbackByChannel: () => scrollback(),
  // BUGHUNT-2 B5: ScrollbackPane's onScroll calls `loadMore` when
  // scrollTop is near the top (CP14 B2). Stubbed as a no-op resolved
  // promise so the scroll-handler can complete without throwing on
  // tests that drive synthetic scroll events. The export name is
  // `loadMore` (production imports it as `loadMore as
  // loadMoreScrollback`).
  loadMore: vi.fn(() => Promise.resolve()),
  // #159 item 2: the visibility-return effect now fires refreshScrollback
  // for activation freshness. Stubbed no-op resolved promise (these specs
  // assert scroll/marker behavior, not the REST catch-up).
  refreshScrollback: vi.fn(() => Promise.resolve()),
  lastOwnSend: () => ownSend(),
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

import { dismissWhoisCard, setWhoisBundle } from "../lib/whoisCard";
import ScrollbackPane, { resetAutoFocusedJoinsForTest } from "../ScrollbackPane";

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
  setDocVisible(true);
  setOwnSend(null);
  mockMembersByChannel.mockReturnValue({});
  // Reset the C5.0 auto-focus shown-set between tests (test seam, see ScrollbackPane.tsx).
  resetAutoFocusedJoinsForTest();
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

  describe("C5.0 — own-nick JOIN auto-focus-switch (UX-5 BJ)", () => {
    // C5.0 — JOIN-self auto-focus-switch (spec #7):
    // When own nick's JOIN event appears in scrollback, the pane MUST call
    // setSelectedChannel to switch focus to that channel. This is a user
    // action (the user issued /join) so the cluster-wide focus-only-on-
    // user-action rule is not violated — the focus-rule invariant tests
    // assert that OTHER-user joins do NOT shift focus.
    //
    // UX-5 BJ (2026-05-19): pre-BJ this contract was entangled with the
    // "JOIN-self banner" mount in the same `createEffect`. BJ killed the
    // banner and the focus side-effect lives on alone via the
    // `shouldAutoFocusOnOwnJoin` memo + `autoFocusedJoins` Set. The
    // assertions below pin the surviving contract.
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

  // Presence-event user@host (irssi-style "nick [user@host] has ...").
  describe("presence user@host rendering", () => {
    const cases: { kind: ScrollbackMessage["kind"]; verb: string }[] = [
      { kind: "join", verb: "has joined" },
      { kind: "part", verb: "has left" },
      { kind: "quit", verb: "has quit" },
    ];

    for (const { kind, verb } of cases) {
      it(`renders [user@host] from meta on ${kind} events`, () => {
        setScrollback({
          "freenode #grappa": [
            {
              id: 1,
              network: "freenode",
              channel: "#grappa",
              server_time: 1_700_000_000_000,
              kind,
              sender: "alice",
              body: kind === "join" ? null : "later",
              meta: { sender_user: "~al", sender_host: "host.example.com" },
            },
          ],
        });
        render(() => (
          <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
        ));
        const line = screen.getByTestId("scrollback-line");
        expect(line.textContent).toContain("alice [~al@host.example.com]");
        expect(line.textContent).toContain(verb);
        setScrollback({});
      });
    }

    it("omits the bracket when meta carries no user@host (cloaked prefix)", () => {
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
      expect(line.textContent).not.toContain("@");
      expect(line.textContent).toContain("alice");
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

    // FREEZE CONTRACT (2026-06-08, vjt "step-away" request): the unread
    // marker is FROZEN for the lifetime of a focus session. A bare
    // mid-view cursor advance — own scroll-settle echo OR cross-device
    // `read_cursor_set` — does NOT move the divider. The marker re-latches
    // to the live cursor only on a focus acquisition (channel-switch = key
    // change, or tab/app visibility-return). Rationale: the divider must
    // not yank under the operator's eyes while they read; it settles to
    // the new position when they step away and back.
    //
    // This REVISES the original CP29 R-4 "Bug A" contract (which asserted
    // the marker disappears immediately on any live-cursor advance). The
    // signal map stays reactive — sidebar badges + selection.ts unread
    // counts still update live; only ScrollbackPane's in-pane marker reads
    // the frozen `markerCursorId` snapshot instead of the live cursor.
    //
    // cic cannot distinguish own-echo from cross-device at the
    // `applyReadCursorSet` boundary (same wire bytes), so the freeze is
    // uniform: cross-device reads reflect on the next refocus, not
    // mid-stare. Accepted tradeoff (vjt: "consistency").
    it("Bug A (revised): bare cursor advance keeps the marker frozen; refocus releases it", async () => {
      const { applyReadCursorSet } = await import("../lib/readCursor");
      const proto = fixture[0];
      if (!proto) throw new Error("fixture[0] missing");
      // 4 unread from peer, cursor at 0 → "4 unread". sessionTopId latches 13.
      const fourUnread: ScrollbackMessage[] = [
        { ...proto, id: 10, server_time: 100, sender: "vjt", body: "msg1" },
        { ...proto, id: 11, server_time: 101, sender: "vjt", body: "msg2" },
        { ...proto, id: 12, server_time: 102, sender: "vjt", body: "msg3" },
        { ...proto, id: 13, server_time: 103, sender: "vjt", body: "msg4" },
      ];
      seedReadCursor("freenode", "#grappa", 0);
      setScrollback({ "freenode #grappa": fourUnread });
      setDocVisible(true);
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      expect(screen.getByTestId("unread-marker")).toHaveTextContent("4 unread");

      // Bare mid-view advance to the latest id. NO focus event.
      applyReadCursorSet("freenode", "#grappa", 13);
      await new Promise((r) => queueMicrotask(() => r(undefined)));
      // FROZEN: marker unchanged despite the live cursor reaching sessionTopId.
      expect(screen.getByTestId("unread-marker")).toHaveTextContent("4 unread");

      // Refocus (tab/app visibility-return) re-latches the marker baseline
      // to the live cursor → cursor caught up to sessionTopId → marker gone.
      setDocVisible(false);
      await new Promise((r) => queueMicrotask(() => r(undefined)));
      setDocVisible(true);
      await waitFor(() => {
        expect(screen.queryByTestId("unread-marker")).toBeNull();
      });
    });

    it("marker stays frozen at its mount count while the cursor advances mid-view", async () => {
      const { applyReadCursorSet } = await import("../lib/readCursor");
      const proto = fixture[0];
      if (!proto) throw new Error("fixture[0] missing");
      const fourUnread: ScrollbackMessage[] = [
        { ...proto, id: 60, server_time: 100, sender: "alice", body: "u1" },
        { ...proto, id: 61, server_time: 101, sender: "alice", body: "u2" },
        { ...proto, id: 62, server_time: 102, sender: "alice", body: "u3" },
        { ...proto, id: 63, server_time: 103, sender: "alice", body: "u4" },
      ];
      // cursor at 59 → marker before id 60, "4 unread". sessionTopId latches 63.
      seedReadCursor("freenode", "#grappa", 59);
      setScrollback({ "freenode #grappa": fourUnread });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      expect(screen.getByTestId("unread-marker")).toHaveTextContent("4 unread");

      // Operator scroll-settle (or cross-device) advances the cursor partway
      // through the unread block. NO focus event → divider must not move.
      applyReadCursorSet("freenode", "#grappa", 62);
      await new Promise((r) => queueMicrotask(() => r(undefined)));
      expect(screen.getByTestId("unread-marker")).toHaveTextContent("4 unread");
    });

    it("marker re-latches to the advanced cursor on visibility-return (option b)", async () => {
      const { applyReadCursorSet } = await import("../lib/readCursor");
      const proto = fixture[0];
      if (!proto) throw new Error("fixture[0] missing");
      const fourUnread: ScrollbackMessage[] = [
        { ...proto, id: 60, server_time: 100, sender: "alice", body: "u1" },
        { ...proto, id: 61, server_time: 101, sender: "alice", body: "u2" },
        { ...proto, id: 62, server_time: 102, sender: "alice", body: "u3" },
        { ...proto, id: 63, server_time: 103, sender: "alice", body: "u4" },
      ];
      seedReadCursor("freenode", "#grappa", 59);
      setScrollback({ "freenode #grappa": fourUnread });
      setDocVisible(true);
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      expect(screen.getByTestId("unread-marker")).toHaveTextContent("4 unread");

      // Advance cursor to 62 while frozen — marker holds at 4.
      applyReadCursorSet("freenode", "#grappa", 62);
      await new Promise((r) => queueMicrotask(() => r(undefined)));
      expect(screen.getByTestId("unread-marker")).toHaveTextContent("4 unread");

      // Step away + back: divider re-latches to the live cursor (62) → only
      // id 63 remains in (62, 63] → "1 unread".
      setDocVisible(false);
      await new Promise((r) => queueMicrotask(() => r(undefined)));
      setDocVisible(true);
      await waitFor(() => {
        expect(screen.getByTestId("unread-marker")).toHaveTextContent("1 unread");
      });
    });

    // Send-relatch (2026-06-09, vjt prod report): a focused OWN send must
    // collapse the in-pane `── XX unread ──` divider immediately. The
    // freeze contract (cp56) froze the divider against PASSIVE advances
    // (scroll-settle echo, cross-device read_cursor_set) so it doesn't
    // yank while reading — but it also stopped a SEND from clearing it,
    // and vjt reported "a '1 unread' marker that didn't disappear on send
    // a new message". A send is an explicit caught-up action (not a
    // background advance), so it re-latches `markerCursorId` to the now-
    // advanced live cursor, the way a focus acquisition does. Passive
    // advances stay frozen — proven by the three tests above which drive
    // `applyReadCursorSet` (NOT `lastOwnSend`) and still hold their count.
    it("focused own send re-latches the marker → divider collapses immediately", async () => {
      const proto = fixture[0];
      if (!proto) throw new Error("fixture[0] missing");
      // 4 unread from a peer, cursor at 9 → marker before id 10, "4 unread".
      // sessionTopId latches 13 at mount.
      const fourUnread: ScrollbackMessage[] = [
        { ...proto, id: 10, server_time: 100, sender: "alice", body: "u1" },
        { ...proto, id: 11, server_time: 101, sender: "alice", body: "u2" },
        { ...proto, id: 12, server_time: 102, sender: "alice", body: "u3" },
        { ...proto, id: 13, server_time: 103, sender: "alice", body: "u4" },
      ];
      setUserNick("vjt");
      seedReadCursor("freenode", "#grappa", 9);
      setScrollback({ "freenode #grappa": fourUnread });
      setDocVisible(true);
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      expect(screen.getByTestId("unread-marker")).toHaveTextContent("4 unread");

      // Operator sends in the focused channel. Production: the own row
      // (id 14) appends via WS and `sendMessage` advances the live cursor
      // optimistically to 14, then fires `lastOwnSend`. Mirror both: the
      // cursor advance (seedReadCursor) AND the own-send signal.
      const ownRow: ScrollbackMessage = {
        ...proto,
        id: 14,
        server_time: 104,
        sender: "vjt",
        body: "my reply",
      };
      setScrollback({ "freenode #grappa": [...fourUnread, ownRow] });
      seedReadCursor("freenode", "#grappa", 14);
      pushOwnSend("freenode #grappa");

      // Divider collapses on the next flush — NO window-switch needed.
      await waitFor(() => {
        expect(screen.queryByTestId("unread-marker")).toBeNull();
      });
    });

    // Send-relatch isolation: a send to a DIFFERENT window (e.g. `/msg`
    // to a query) must NOT collapse THIS pane's frozen divider. The
    // re-latch is keyed to the pane's own `(slug, channel)`.
    it("own send to a DIFFERENT window leaves this pane's marker frozen", async () => {
      const proto = fixture[0];
      if (!proto) throw new Error("fixture[0] missing");
      const fourUnread: ScrollbackMessage[] = [
        { ...proto, id: 10, server_time: 100, sender: "alice", body: "u1" },
        { ...proto, id: 11, server_time: 101, sender: "alice", body: "u2" },
        { ...proto, id: 12, server_time: 102, sender: "alice", body: "u3" },
        { ...proto, id: 13, server_time: 103, sender: "alice", body: "u4" },
      ];
      setUserNick("vjt");
      seedReadCursor("freenode", "#grappa", 9);
      setScrollback({ "freenode #grappa": fourUnread });
      setDocVisible(true);
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      expect(screen.getByTestId("unread-marker")).toHaveTextContent("4 unread");

      // Send lands on a sibling window's key — wrong (slug, channel).
      pushOwnSend("freenode bob");
      await new Promise((r) => queueMicrotask(() => r(undefined)));
      expect(screen.getByTestId("unread-marker")).toHaveTextContent("4 unread");
    });

    // Send-relatch dedup guard (2026-06-09): a SECOND send to the same
    // channel must also hide the marker. `lastOwnSend` carries the same
    // key string both times; without `equals: false` SolidJS Object.is-
    // dedups the repeat set → the effect never re-runs → the marker
    // sticks. Repro: send in #foo (hides) → switch away → peer messages
    // #foo → switch back, marker re-shows → reply in #foo (same key) →
    // must hide. The switch-away-and-back is modelled by a remount
    // (fresh sessionTopId), which is what a real channel-switch does.
    it("a repeat send to the same channel re-hides a re-shown marker", async () => {
      const proto = fixture[0];
      if (!proto) throw new Error("fixture[0] missing");
      setUserNick("vjt");
      const peerRows: ScrollbackMessage[] = [
        { ...proto, id: 10, server_time: 10, sender: "alice", body: "u1" },
        { ...proto, id: 11, server_time: 11, sender: "alice", body: "u2" },
        { ...proto, id: 12, server_time: 12, sender: "alice", body: "u3" },
        { ...proto, id: 13, server_time: 13, sender: "alice", body: "u4" },
      ];
      const ownR1: ScrollbackMessage = {
        ...proto,
        id: 14,
        server_time: 14,
        sender: "vjt",
        body: "r1",
      };

      // First focus: marker showing (cursor 9 < peer ids, sessionTop 13).
      seedReadCursor("freenode", "#grappa", 9);
      setScrollback({ "freenode #grappa": peerRows });
      setDocVisible(true);
      const first = render(() => (
        <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
      ));
      expect(screen.getByTestId("unread-marker")).toHaveTextContent("4 unread");

      // Send #1 → marker hides (own row 14, cursor → 14).
      setScrollback({ "freenode #grappa": [...peerRows, ownR1] });
      seedReadCursor("freenode", "#grappa", 14);
      pushOwnSend("freenode #grappa");
      await waitFor(() => expect(screen.queryByTestId("unread-marker")).toBeNull());

      // Switch away + back (remount = fresh sessionTopId). A peer messaged
      // #foo while away (id 15) → cursor 14 < new sessionTop 15 → marker
      // re-shows "1 unread".
      first.unmount();
      const peerWhileAway: ScrollbackMessage = {
        ...proto,
        id: 15,
        server_time: 15,
        sender: "alice",
        body: "while away",
      };
      setScrollback({ "freenode #grappa": [...peerRows, ownR1, peerWhileAway] });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      expect(screen.getByTestId("unread-marker")).toHaveTextContent("1 unread");

      // Reply AGAIN in #foo — SAME channel-key as send #1. Must re-hide.
      const ownR2: ScrollbackMessage = {
        ...proto,
        id: 16,
        server_time: 16,
        sender: "vjt",
        body: "r2",
      };
      setScrollback({ "freenode #grappa": [...peerRows, ownR1, peerWhileAway, ownR2] });
      seedReadCursor("freenode", "#grappa", 16);
      pushOwnSend("freenode #grappa");
      await waitFor(() => expect(screen.queryByTestId("unread-marker")).toBeNull());
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

    // REV-G H23 (2026-05-22): regression pin on the markerRef function-
    // ref signal + onCleanup refactor. Pre-REV-G `markerRef` was a
    // `let`-bound ref; SolidJS doesn't auto-null let-bound refs on
    // unmount, so when the marker row was removed mid-channel (cursor
    // advance — same scenario as Bug A above), subsequent reads of
    // `markerRef` still pointed at the now-detached DOM node. A
    // visibility-return after mid-channel removal would call
    // `scrollIntoView` on the stale node and either throw (real browser
    // TypeError on detached node) or silently no-op (jsdom optional-
    // chain swallowed the call).
    //
    // Post-REV-G `markerRef` is a `createSignal` function-ref + an
    // explicit `onCleanup` at the marker JSX (SolidJS function-refs
    // are mount-only; React-style auto-null on unmount requires the
    // explicit hook). Signal flips back to undefined on unmount;
    // downstream readers (`scrollToActivation`, length-effect) take
    // the marker-absent branch.
    //
    // Pin strategy: spy on `Element.prototype.scrollIntoView` (same
    // polyfill pattern the "scroll-on-activate canonical" describe
    // block uses) and assert it's NOT called between the cursor-
    // advance-mid-channel and post-visibility-return checkpoints.
    // The marker-absent branch sets scrollTop directly; scrollIntoView
    // belongs ONLY to the marker-present path. A regression to a let-
    // bound ref OR a missing `onCleanup` would surface as a stray
    // scrollIntoView call on the detached marker node.
    it("REV-G H23: visibility-return after mid-channel marker removal does NOT call scrollIntoView (stale-ref pin)", async () => {
      const { applyReadCursorSet } = await import("../lib/readCursor");
      const proto = fixture[0];
      if (!proto) throw new Error("fixture[0] missing");

      const scrollIntoViewSpy = vi.fn();
      // biome-ignore lint/suspicious/noExplicitAny: jsdom Element type compat
      const origScrollIntoView = (Element.prototype as any).scrollIntoView;
      // biome-ignore lint/suspicious/noExplicitAny: jsdom Element type compat
      (Element.prototype as any).scrollIntoView = scrollIntoViewSpy;

      try {
        const fourUnread: ScrollbackMessage[] = [
          { ...proto, id: 50, server_time: 100, sender: "alice", body: "u1" },
          { ...proto, id: 51, server_time: 101, sender: "alice", body: "u2" },
          { ...proto, id: 52, server_time: 102, sender: "alice", body: "u3" },
          { ...proto, id: 53, server_time: 103, sender: "alice", body: "u4" },
        ];
        seedReadCursor("freenode", "#grappa", 0);
        setScrollback({ "freenode #grappa": fourUnread });
        setDocVisible(true);
        render(() => (
          <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
        ));

        // Marker present after mount; the length-effect's initial run
        // may or may not have fired scrollIntoView depending on jsdom
        // flush order. We don't care — the regression pin is the
        // POST-visibility-return checkpoint.
        expect(screen.getByTestId("unread-marker")).toBeInTheDocument();

        // FREEZE CONTRACT (2026-06-08): a bare cursor advance no longer
        // removes the marker — it's frozen. The marker DOM row now unmounts
        // when a FOCUS acquisition re-latches the frozen boundary past the
        // unread block. Advance the live cursor, then drive ONE
        // visibility-return: that re-latches markerCursorId=53 → marker row
        // unmounts → onCleanup fires setMarkerRef(undefined). (Yield between
        // transitions so SolidJS flushes the false state — effect captures
        // prev=false — before we flip back to true; otherwise both writes
        // batch and the effect's prev=undefined guard returns early.)
        applyReadCursorSet("freenode", "#grappa", 53);
        setDocVisible(false);
        await new Promise((r) => queueMicrotask(() => r(undefined)));
        setDocVisible(true);
        await waitFor(() => {
          expect(screen.queryByTestId("unread-marker")).toBeNull();
        });

        // Clear the spy: the marker is now unmounted and its ref nulled.
        // From THIS point a SECOND visibility-return must NOT scrollIntoView
        // a stale detached marker node — the regression pin. Pre-REV-G the
        // stale-ref path would fire scrollIntoView during the activation
        // effect.
        scrollIntoViewSpy.mockClear();

        setDocVisible(false);
        await new Promise((r) => queueMicrotask(() => r(undefined)));
        setDocVisible(true);
        await new Promise((r) => queueMicrotask(() => r(undefined)));

        // GREEN post-fix: 0 scrollIntoView calls — marker gone, signal
        // returns undefined, fall-through branch (scrollTop = ...) ran.
        // RED pre-fix: scrollIntoView called on the detached marker
        // div still held by the let-bound ref / signal-without-cleanup.
        expect(scrollIntoViewSpy).not.toHaveBeenCalled();
      } finally {
        // biome-ignore lint/suspicious/noExplicitAny: jsdom Element type compat
        (Element.prototype as any).scrollIntoView = origScrollIntoView;
      }
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

  // Media-link cluster (2026-06-11): same-origin upload URLs are
  // in-PWA-scope — iOS standalone navigates them IN PLACE (raw media
  // doc, no chrome, return reloads cic). classifyMediaLink-accepted
  // links get a click intercept that opens the in-app viewer instead;
  // everything else keeps the plain target=_blank anchor untouched.
  describe("media links open the in-app viewer (media-link cluster)", () => {
    beforeEach(() => {
      closeMediaViewer();
      closeAudio();
    });

    it("📸-prefixed same-origin upload URL: click is intercepted and opens the viewer", () => {
      const href = `${window.location.origin}/uploads/abcdefghijklmnopqrstuvwxyz`;
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1,
            kind: "privmsg",
            sender: "alice",
            body: `📸 ${href}`,
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const link = document.querySelector(".scrollback-link") as HTMLAnchorElement;
      expect(link).not.toBeNull();
      expect(link.classList.contains("scrollback-media-link")).toBe(true);
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
      link.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(mediaViewerState()).toEqual({ href, kind: "image" });
    });

    it("🎬-prefixed same-origin upload URL opens the viewer with video kind", () => {
      const href = `${window.location.origin}/uploads/zyxwvutsrqponmlkjihgfedcba`;
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1,
            kind: "privmsg",
            sender: "bob",
            body: `🎬 ${href}`,
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const link = document.querySelector(".scrollback-link") as HTMLAnchorElement;
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
      link.dispatchEvent(ev);
      expect(mediaViewerState()).toEqual({ href, kind: "video" });
    });

    it("🎵-prefixed same-origin upload URL opens the docked mini-player, NOT the modal", () => {
      const href = `${window.location.origin}/uploads/mmmmmmmmmmmmmmmmmmmmmmmmmm`;
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1,
            kind: "privmsg",
            sender: "bob",
            body: `🎵 ${href}`,
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const link = document.querySelector(".scrollback-link") as HTMLAnchorElement;
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
      link.dispatchEvent(ev);
      // Audio routes to the non-modal docked player; the image/video
      // viewer modal stays closed.
      expect(activeAudio()).toEqual({ href });
      expect(mediaViewerState()).toBeNull();
    });

    it("modifier-click (cmd/ctrl) is NOT intercepted — browser new-tab semantics stand", () => {
      const href = `${window.location.origin}/uploads/abcdefghijklmnopqrstuvwxyz`;
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1,
            kind: "privmsg",
            sender: "alice",
            body: `📸 ${href}`,
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const link = document.querySelector(".scrollback-link") as HTMLAnchorElement;
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
      // Record whether the component handler preventDefault'd, then
      // suppress the default ourselves so jsdom doesn't attempt a real
      // navigation (document bubble listener runs after the anchor's).
      let preventedByHandler: boolean | null = null;
      const recorder = (e: Event) => {
        preventedByHandler = e.defaultPrevented;
        e.preventDefault();
      };
      document.addEventListener("click", recorder);
      link.dispatchEvent(ev);
      document.removeEventListener("click", recorder);
      expect(preventedByHandler).toBe(false);
      expect(mediaViewerState()).toBeNull();
    });

    it("plain web link is NOT media-classified — anchor keeps default behavior", () => {
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
      expect(link.classList.contains("scrollback-media-link")).toBe(false);
      expect(mediaViewerState()).toBeNull();
    });

    it("cross-origin 📸 URL (litterbox host) is NOT intercepted", () => {
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1,
            kind: "privmsg",
            sender: "alice",
            body: "📸 https://litter.catbox.moe/abc.png",
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const link = document.querySelector(".scrollback-link") as HTMLAnchorElement;
      expect(link.classList.contains("scrollback-media-link")).toBe(false);
    });
  });

  // Review fix (2026-06-11): the in-place-navigation bug class covers
  // EVERY same-host link, not just modal-viewable media. 📄 document
  // uploads (classifyMediaLink deliberately rejects them — no PDF
  // rendering in the modal) and emoji-split-run fallbacks keep the
  // plain anchor, which iOS standalone navigates IN PLACE. Those
  // clicks delegate to the shared escape handler instead (no-op on
  // every other platform — pinned in platform.test.ts).
  describe("same-host non-media links escape the iOS-standalone PWA", () => {
    const seed = (body: string) => {
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1,
            kind: "privmsg",
            sender: "alice",
            body,
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      return document.querySelector(".scrollback-link") as HTMLAnchorElement;
    };

    beforeEach(() => {
      mockMaybeEscapePwaClick.mockClear();
    });

    it("📄 same-host doc upload link: plain click delegates to the escape handler, href untouched", () => {
      const href = `${window.location.origin}/uploads/abcdefghijklmnopqrstuvwxyz`;
      const link = seed(`📄 ${href}`);
      expect(link.classList.contains("scrollback-media-link")).toBe(false);
      expect(link.getAttribute("href")).toBe(href);
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
      link.dispatchEvent(ev);
      expect(mockMaybeEscapePwaClick).toHaveBeenCalledTimes(1);
      expect(mockMaybeEscapePwaClick.mock.calls[0]?.[1]).toBe(href);
    });

    it("historical http:// same-host link: handler receives the page-origin-rooted href", () => {
      // Pre-fix prod minted http:// upload URLs (Endpoint url: had no
      // scheme); the escape must hand Safari the live https URL, not
      // the mixed-content one. Same re-rooting contract as the viewer.
      const httpHref = `http://${window.location.host}/uploads/abcdefghijklmnopqrstuvwxyz`;
      const link = seed(`📄 ${httpHref}`);
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
      link.dispatchEvent(ev);
      expect(mockMaybeEscapePwaClick.mock.calls[0]?.[1]).toBe(
        `${window.location.origin}/uploads/abcdefghijklmnopqrstuvwxyz`,
      );
    });

    it("cross-host link: click is NOT delegated — out-of-scope already opens correctly", () => {
      const link = seed("docs at https://example.com/page");
      let preventedByHandler: boolean | null = null;
      const recorder = (e: Event) => {
        preventedByHandler = e.defaultPrevented;
        e.preventDefault();
      };
      document.addEventListener("click", recorder);
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      document.removeEventListener("click", recorder);
      expect(mockMaybeEscapePwaClick).not.toHaveBeenCalled();
      expect(preventedByHandler).toBe(false);
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

    it("renders \\x1e strikethrough with .scrollback-mirc-strikethrough", () => {
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1,
            kind: "privmsg",
            sender: "alice",
            body: "a\x1egone\x1eb",
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const spans = document.querySelector(".scrollback-body")?.querySelectorAll("span");
      expect(spans?.[1]?.classList.contains("scrollback-mirc-strikethrough")).toBe(true);
      expect(spans?.[1]?.textContent).toBe("gone");
      expect(spans?.[0]?.classList.contains("scrollback-mirc-strikethrough")).toBe(false);
    });

    it("renders \\x11 monospace with .scrollback-mirc-monospace", () => {
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1,
            kind: "privmsg",
            sender: "alice",
            body: "\x11code()\x11",
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const span = document.querySelector(".scrollback-body span") as HTMLElement | null;
      expect(span?.classList.contains("scrollback-mirc-monospace")).toBe(true);
      expect(span?.textContent).toBe("code()");
    });

    it("renders \\x04 hex fg color via inline style", () => {
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1,
            kind: "privmsg",
            sender: "alice",
            body: "\x04ff8800orange\x04",
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const colored = document.querySelector(".scrollback-body span") as HTMLElement | null;
      // #ff8800 → jsdom rgb.
      expect(colored?.style.color).toBe("rgb(255, 136, 0)");
      expect(colored?.textContent).toBe("orange");
    });
  });

  // UX-4 bucket K (2026-05-19) — canonical window-activation scroll.
  // Two activation triggers (selectedChannel change + visibility false→
  // true) converge on the same `scrollToActivation` routine: marker
  // present → scrollIntoView({block: "center"}); no marker → snap to
  // tail. The selectedChannel-change branch is already exercised
  // indirectly by other tests via initial render; this block focuses
  // on the new visibility-return trigger.
  describe("scroll-on-activate canonical (bucket K)", () => {
    // jsdom does not implement Element.prototype.scrollIntoView; the
    // production code optional-chains the call (`?.({block:...})`) but
    // tests need a spy on the property to verify the routine fired.
    // Polyfill + restore per test so the spy doesn't leak between
    // tests in the suite.
    let scrollIntoViewSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      scrollIntoViewSpy = vi.fn();
      // Element.prototype assignment so every node (including
      // dynamically-rendered <For> children) inherits the spy.
      // biome-ignore lint/suspicious/noExplicitAny: jsdom Element type compat
      (Element.prototype as any).scrollIntoView = scrollIntoViewSpy;
    });

    it("visibility false→true on a window with NO unread marker snaps scrollTop to scrollHeight", async () => {
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1,
            kind: "privmsg",
            sender: "alice",
            body: "hello",
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);

      // Initial mount: prev === undefined, no visibility-trigger fire.
      // Drive false then true so the createEffect sees a real
      // false→true transition and calls scrollToActivation.
      setDocVisible(false);
      setDocVisible(true);

      // queueMicrotask delays the DOM read+write; wait for it to flush.
      await new Promise((r) => queueMicrotask(() => r(undefined)));

      // No marker → routine takes the scrollTop branch, not scrollIntoView.
      expect(scrollIntoViewSpy).not.toHaveBeenCalled();
      // atBottom branch sets atBottom=true → scroll-to-bottom button hidden.
      expect(screen.queryByTestId("scroll-to-bottom")).toBeNull();
    });

    it("visibility true→true (no transition) does NOT re-fire the activation routine", async () => {
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1,
            kind: "privmsg",
            sender: "alice",
            body: "hello",
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);

      // Same value: createEffect's `on(isDocumentVisible, ...)` only
      // fires when the tracked signal actually changes. Solid de-dupes
      // identical values; re-setting true is a no-op.
      setDocVisible(true);
      await new Promise((r) => queueMicrotask(() => r(undefined)));

      expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    });

    it("initial mount does NOT trigger the visibility-activation routine (prev === undefined guard)", async () => {
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1,
            kind: "privmsg",
            sender: "alice",
            body: "hello",
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      await new Promise((r) => queueMicrotask(() => r(undefined)));

      // On initial mount, `on(isDocumentVisible, (visible, prev) =>
      // { if (prev === undefined) return; ... })` short-circuits.
      // The length-effect handles initial render scroll; the
      // visibility-activation effect is dormant until a real
      // transition fires.
      expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    });

    it("visibility true→false does NOT trigger the routine (only false→true edge fires)", async () => {
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1,
            kind: "privmsg",
            sender: "alice",
            body: "hello",
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      // Drive an explicit true→false transition. selection.ts owns
      // this edge (cursor settle); ScrollbackPane's activation effect
      // is silent here.
      setDocVisible(false);
      await new Promise((r) => queueMicrotask(() => r(undefined)));

      expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    });

    // #130 — content flicker on window activation. The activation scroll
    // lands inside a double-rAF (geometry is only correct after Solid
    // commits the new <For> rows AND layout settles — see the
    // scrollToActivation doc comment), which is necessarily AFTER the
    // browser has already painted the swapped-in content at the OLD
    // preserved scrollTop. The user sees the content render, then jump.
    // Fix: hide the scrollback container synchronously at activation
    // (pre-paint) and reveal it only once the deferred scroll has
    // settled — the wrong-scroll frame is never shown.
    it("#130: hides the scrollback until the activation scroll settles, then reveals it", async () => {
      // Drive rAF manually so we can observe the hidden window between
      // the synchronous activation and the deferred scroll settle.
      const rafQueue: FrameRequestCallback[] = [];
      const rafSpy = vi
        .spyOn(globalThis, "requestAnimationFrame")
        .mockImplementation((cb: FrameRequestCallback) => {
          rafQueue.push(cb);
          return rafQueue.length;
        });
      const flushRaf = (): void => {
        // Drain nested rAFs (scrollToActivation schedules an inner rAF
        // from inside the outer one) until quiescent.
        for (let i = 0; i < 8 && rafQueue.length > 0; i++) {
          const cbs = rafQueue.splice(0);
          for (const cb of cbs) cb(0);
        }
      };
      try {
        setScrollback({
          "freenode #grappa": [
            {
              id: 1,
              network: "freenode",
              channel: "#grappa",
              server_time: 1,
              kind: "privmsg",
              sender: "alice",
              body: "hello",
              meta: {},
            },
          ],
        });
        render(() => (
          <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
        ));
        const pane = screen.getByTestId("scrollback");

        // Drain the mount-time rAFs (measureOverflow / length-effect) so
        // the queue only holds the activation rAFs after we trigger it.
        flushRaf();

        // Activation: visibility false→true converges on scrollToActivation.
        setDocVisible(false);
        setDocVisible(true);

        // Synchronously (pre-paint), the pane must be hidden — the
        // deferred scroll has NOT run yet (its rAFs are still queued).
        expect(pane.style.visibility).toBe("hidden");

        // Settle the deferred scroll → pane revealed.
        flushRaf();
        expect(pane.style.visibility).toBe("visible");
      } finally {
        rafSpy.mockRestore();
      }
    });
  });

  // BUGHUNT-2: input-event gate. Programmatic scroll without preceding
  // pointerdown/wheel/touchmove/keydown does NOT arm the settle timer →
  // setCursorIfAdvances is not called. The positive path (real input
  // arms the gate + cursor advances) is covered by e2e B3 because the
  // jsdom layout returns null for `lastFullyVisibleRowId` (no real
  // viewport) so a jsdom positive test would not exercise the POST
  // branch.
  describe("BUGHUNT-2 input-event gate", () => {
    it("scroll without preceding pointerdown does NOT call setCursorIfAdvances", async () => {
      // Seed enough rows for the scroll-settle path to be considered.
      const rows: ScrollbackMessage[] = Array.from({ length: 30 }, (_, i) => ({
        id: i + 1,
        network: "freenode",
        channel: "#grappa",
        server_time: i + 1,
        kind: "privmsg",
        sender: "alice",
        body: `row ${i + 1}`,
        meta: {},
      }));
      setScrollback({ "freenode #grappa": rows });

      const { container } = render(() => (
        <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
      ));
      const list = container.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
      expect(list).not.toBeNull();
      if (!list) throw new Error("scrollback DOM not found");

      // Fire scroll without any prior pointerdown / wheel / touchmove /
      // keydown. The gate's `lastInputEventAtMs` stays null → settle
      // timer never arms.
      list.scrollTop = 100;
      list.dispatchEvent(new Event("scroll"));

      // Wait past the 500ms debounce + slop. Use real timers (this
      // suite doesn't enable fake timers).
      await new Promise((r) => setTimeout(r, 700));

      expect(mockSetCursorIfAdvances).not.toHaveBeenCalled();
    });
  });

  // #133 — WHOIS / WHOWAS / LUSERS / peer-away are top-pinned ephemeral
  // affordances. Rendered as flex siblings BEFORE `.scrollback` they
  // shrink the scroll list when they mount, shifting the reader's anchor
  // and losing their place in the channel buffer. The fix moves the whole
  // family into a dedicated overlay layer that floats above the scroll
  // list instead of sharing its flow. This pins the structural contract:
  // the card lives in the overlay, the scroll list does NOT.
  describe("#133 top-pinned cards float in an overlay, not the scroll flow", () => {
    const overlayBundle: WhoisBundle = {
      network: "overlaynet",
      target: "carol",
      user: "carol_u",
      host: "carol.host",
      realname: "Carol",
      server: "irc.overlaynet",
      server_info: "Overlay Hub",
      is_operator: false,
      idle_seconds: null,
      signon: null,
      channels: null,
      using_ssl: false,
      is_registered: false,
      is_admin: false,
      is_services_admin: false,
      is_helper: false,
      is_chanop: false,
      is_agent: false,
      is_java: false,
      umodes: null,
      away_message: null,
      actually_host: null,
      actually_ip: null,
    };

    afterEach(() => {
      dismissWhoisCard("overlaynet");
    });

    it("mounts the WHOIS card inside the overlay layer, separate from the scroll list", () => {
      setWhoisBundle("overlaynet", overlayBundle);
      render(() => <ScrollbackPane networkSlug="overlaynet" channelName="#x" kind="channel" />);

      const overlay = screen.getByTestId("scrollback-overlay");
      const card = screen.getByTestId("whois-card");
      const list = screen.getByTestId("scrollback");

      // The card floats in the overlay layer...
      expect(overlay).toContainElement(card);
      // ...and the overlay must NOT wrap the scroll list — that separation
      // is what keeps the reader's scroll position stable when a card mounts.
      expect(overlay).not.toContainElement(list);
    });
  });
});
