import { render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrollbackMessage, WhoisBundle } from "../lib/api";
import { activeAudio, closeAudio } from "../lib/audioPlayer";
import { closeMediaViewer, mediaViewerState } from "../lib/mediaViewer";
import {
  popOverlay,
  pushOverlay,
  __resetForTest as resetOverlayLock,
} from "../lib/overlayScrollLock";
// #981 — the REAL shared signal the pane publishes its read-at-the-tail
// answer into (the badge derivation in selection.ts reads it). Not mocked:
// the pane is its only writer and what these tests assert IS the write.
import { readingAtTailKey } from "../lib/readingAtTail";
// #230 — the mocked `loadMore` (see vi.mock("../lib/scrollback")) so the
// wheel-up-on-underfill trigger can be asserted directly.
import { loadMore } from "../lib/scrollback";

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
// #580 — the submit-time send signal (published SYNCHRONOUSLY before the POST
// in production). ScrollbackPane reads it to snap to the bottom + reset the
// follow-state the instant enter is pressed, independent of the network. The
// divider re-latch stays on `lastOwnSend` (post-resolve). Signal-backed
// stand-in; `pushOwnSendSubmitted` is the test verb that fires a submit.
const [ownSubmitted, setOwnSubmitted] = createSignal<string | null>(null, { equals: false });
const pushOwnSendSubmitted = (key: string) => setOwnSubmitted(key);
// #693 — far-behind state for the pane under test (see the scrollback mock).
const [farBehind, setFarBehind] = createSignal<
  Record<string, { missed: number; resumeFrom: number }>
>({});
// #947 — the server-measured unread count for a pane whose loaded unread
// region is truncated (set by a jump that could only carry one page back).
// Stamped with the cursor it was measured `at`, so the pane spends it only
// while its frozen divider is still anchored to that same cursor.
const [measuredUnread, setMeasuredUnread] = createSignal<
  Record<string, { at: number; count: number }>
>({});
// Resolves TRUE by default (the swap happened) — the pane chains off the
// result to stand the marker latch back down on a failed jump.
const jumpToUnreadSpy = vi.fn((_slug: string, _name: string) => Promise.resolve(true));
// Returns the id it marked read; the pane re-latches its frozen divider to it.
const dismissFarBehindSpy = vi.fn((_slug: string, _name: string): number | null => 3);
vi.mock("../lib/scrollback", () => ({
  scrollbackByChannel: () => scrollback(),
  // BUGHUNT-2 B5: ScrollbackPane's onScroll calls `loadMore` when
  // scrollTop is near the top (CP14 B2). Stubbed as a no-op resolved
  // promise so the scroll-handler can complete without throwing on
  // tests that drive synthetic scroll events. The export name is
  // `loadMore` (production imports it as `loadMore as
  // loadMoreScrollback`).
  loadMore: vi.fn(() => Promise.resolve()),
  // #161: onScroll also calls `loadNewer` when the pane nears the BOTTOM
  // (forward-paging, production imports it as `loadNewer as
  // loadNewerScrollback`). Same no-op resolved-promise stub so synthetic
  // scroll events don't throw on the missing export.
  loadNewer: vi.fn(() => Promise.resolve()),
  // #159 item 2: the visibility-return effect now fires refreshScrollback
  // for activation freshness. Stubbed no-op resolved promise (these specs
  // assert scroll/marker behavior, not the REST catch-up).
  refreshScrollback: vi.fn(() => Promise.resolve()),
  lastOwnSend: () => ownSend(),
  ownSendSubmitted: () => ownSubmitted(),
  // #693 — the far-behind record for the rendered window (empty by default,
  // i.e. an ordinary contiguous pane) plus the jump verb the boundary row
  // fires. Signal-backed so a spec can flip a window into the far-behind
  // state after mount, the same way `setScrollback` drives the row list.
  farBehindByChannel: () => farBehind(),
  // #947 — signal-backed for the same reason as `farBehindByChannel`: a spec
  // drives the post-jump state (rows swapped, flag cleared, count carried).
  measuredUnreadByChannel: () => measuredUnread(),
  // Wrapped, not passed by reference: `vi.mock` is hoisted above the spy
  // declarations, so the factory may only DEFER to them.
  jumpToUnread: (slug: string, name: string) => jumpToUnreadSpy(slug, name),
  dismissFarBehind: (slug: string, name: string) => dismissFarBehindSpy(slug, name),
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

// #280 — ScrollbackPane now mounts NextActiveButton inside its float
// stack (mobile). Stub the child: this suite unit-tests ScrollbackPane's
// own projection/scroll behavior, not the next-active affordance (covered
// by activeWindows unit tests + the #280 e2e). Stubbing it also keeps
// activeWindows' full reactive dependency graph (channelsBySlug /
// messagesUnread / mentions) out of this suite's mock surface.
vi.mock("../NextActiveButton", () => ({ default: () => null }));

// #370 — the keyword-highlight list. Signal-backed stand-in so a test can
// stage custom highlight patterns BEFORE render (the real store mirrors the
// server round-trip; here we drive its value directly). Mocking it also
// keeps highlightList's socket push verbs out of this suite's mock surface.
const [highlightPatternsSig, setHighlightPatternsForTest] = createSignal<string[]>([]);
vi.mock("../lib/highlightList", () => ({
  highlightPatterns: () => highlightPatternsSig(),
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
  // Deliberately NOT folding, unlike prod: the fixtures in this file key
  // `setScrollback` / `seedReadCursor` with raw names (`freenode NickServ`),
  // so a folding composite key would orphan every one of them. The identity
  // is safe here because no test drives two spellings of the same window.
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
  // Faithful to the `${slug} ${name}` mock shape: split on the first space.
  // Needed once a test drives a real channel switch (the key-change effects
  // decode the leaving/arriving key); identity fold matches the mock's
  // non-folding channelKey.
  decodeChannelKey: (key: string) => {
    const i = key.indexOf(" ");
    return i < 0 ? null : { slug: key.slice(0, i), name: key.slice(i + 1) };
  },
  // #799 — this WAS the identity, which made the mock lie about the one thing
  // the function exists to do, so no test could ever observe a missing fold.
  // Spelled out inline rather than re-exporting the real `asciiFold`: a mock
  // that delegates to the module it stands in for cannot catch that module
  // regressing, and the `A-Z`-only fold table is one regex.
  canonicalChannel: (name: string) =>
    name.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)),
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

import type { ChannelKey } from "../lib/channelKey";
// #325 — the REAL channelTopic store (not mocked). `seedTopic` stages a topic
// entry so ScrollbackPane derives the #237 on-JOIN topic-join line; the #325
// block proves that line survives the #222 presence-hide filter.
import { seedTopic } from "../lib/channelTopic";
// #222 — the REAL presence-filter module (not mocked). Its per-channel pref
// signal drives the rows() render filter; these imports let the wiring test
// seed/clear explicit prefs. `channelKey` is mocked above to `${slug} ${name}`
// so the keys below match what ScrollbackPane's `key()` produces.
import {
  clearChannelPresencePref,
  LARGE_CHANNEL_THRESHOLD,
  setChannelPresencePref,
} from "../lib/presenceFilter";
// #310 — the #243 re-tap command signal. NOT mocked (real module): driving
// it exercises the SAME `scrollToBottomGesture` the floating scroll-to-bottom
// button's onClick invokes, so the unit test can prove the shared gesture
// advances the read cursor without needing the button to render (jsdom's
// zero-geometry keeps `atBottom` true, so the button never mounts).
import { requestScrollToBottom } from "../lib/scrollToBottomCommand";
import { dismissWhoisCard, setWhoisBundle } from "../lib/whoisCard";
import ScrollbackPane, {
  resetAutoFocusedJoinsForTest,
  shouldLockScrollGate,
  shouldRescueUnderfillLoadOlder,
} from "../ScrollbackPane";

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
  setHighlightPatternsForTest([]);
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

  it("renders an own CTCP query self-echo in the SOURCE window, target read from meta — #591/#640", () => {
    // #591 — the operator's own /ctcp + /ping self-echo back as a :privmsg
    // whose body is the raw \x01VERB args\x01 frame, tagged by the server with
    // typed meta.ctcp_verb / meta.ctcp_args (SSOT Grappa.IRC.CTCP.verb_args/1).
    // The render shows "→ CTCP VERB [args] to <target>" instead of the raw \x01.
    // cic reads the TYPED meta, never \x01 (the "one IRC parser" invariant).
    //
    // #640 — the echo is keyed to the SOURCE window the command was typed in
    // (msg.channel = "#grappa"), and the wire recipient rides meta.ctcp_target
    // ("bob"). The render MUST read the target OFF the message, not the routing
    // key. This fixture pins channel (the source) DISTINCT from the target —
    // exactly the conflation (channel == target) the pre-#640 fixture baked in,
    // which is what hid the split-window bug. Never assert the buggy shape.
    const ctcpSelfEcho: ScrollbackMessage[] = [
      {
        id: 1,
        network: "freenode",
        channel: "#grappa", // SOURCE window (where /ctcp was typed)
        server_time: 1,
        kind: "privmsg",
        sender: "alice",
        body: "\x01VERSION\x01",
        meta: { ctcp_verb: "VERSION", ctcp_args: "", ctcp_target: "bob" }, // wire recipient
      },
      {
        id: 2,
        network: "freenode",
        channel: "#grappa", // SOURCE window
        server_time: 2,
        kind: "privmsg",
        sender: "alice",
        body: "\x01PING 1706743200000\x01",
        meta: { ctcp_verb: "PING", ctcp_args: "1706743200000", ctcp_target: "bob" },
      },
    ];
    setScrollback({ "freenode #grappa": ctcpSelfEcho });
    render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
    const lines = screen.getAllByTestId("scrollback-line");
    expect(lines).toHaveLength(2);
    // Target is the wire recipient (bob), read from meta.ctcp_target — NOT the
    // routing key (#grappa, the source window). The raw \x01 never renders.
    expect(lines[0]?.dataset.kind).toBe("privmsg");
    expect(lines[0]).toHaveTextContent("→ CTCP VERSION to bob");
    // The source window name must NEVER appear as the target (the #640 bug).
    expect(lines[0]?.textContent ?? "").not.toContain("#grappa");
    expect(lines[0]?.textContent ?? "").not.toContain("\x01");
    // Arg-carrying verb → the token rides after the verb, still to bob.
    expect(lines[1]).toHaveTextContent("→ CTCP PING 1706743200000 to bob");
    expect(lines[1]?.textContent ?? "").not.toContain("#grappa");
    expect(lines[1]?.textContent ?? "").not.toContain("\x01");
  });

  it("falls back to the routing key for a pre-#640 echo with no ctcp_target", () => {
    // Backward-compat: rows persisted before #640 were keyed to the TARGET
    // (msg.channel) and carry no meta.ctcp_target. The render falls back to
    // msg.channel so a historical "/ctcp #chan VERSION" echo still names the
    // right peer instead of a blank/undefined target.
    const legacy: ScrollbackMessage[] = [
      {
        id: 1,
        network: "freenode",
        channel: "#chan",
        server_time: 1,
        kind: "privmsg",
        sender: "alice",
        body: "\x01VERSION\x01",
        meta: { ctcp_verb: "VERSION", ctcp_args: "" }, // no ctcp_target (pre-#640 row)
      },
    ];
    setScrollback({ "freenode #chan": legacy });
    render(() => <ScrollbackPane networkSlug="freenode" channelName="#chan" kind="channel" />);
    const lines = screen.getAllByTestId("scrollback-line");
    expect(lines[0]).toHaveTextContent("→ CTCP VERSION to #chan");
  });

  it("renders an uncorrelated inbound CTCP notice from typed meta, never raw \\x01 — #641", () => {
    // #641 — an inbound CTCP reply (a NOTICE carrying \x01VERB [args]\x01) that
    // matches no pending /ping is NOT consumed by subscribe.ts's
    // maybeConsumePingReply (that swallows only CORRELATED PING replies). It
    // reaches this render, where — before the fix — the notice arm fell through
    // to the generic body render and leaked the raw \x01 delimiters into the DOM
    // (`-NickServ- ^APING^A`), breaking the "cic NEVER shows \x01" invariant that
    // only the privmsg arm (#591) had upheld.
    //
    // The server already classified it: meta.ctcp_verb is present (SSOT
    // Grappa.IRC.CTCP.verb_args/1 tags EVERY inbound CTCP notice at
    // event_router.ex:2236). cic reads the TYPED meta and renders a human INBOUND
    // line (← ... from <sender>) — it NEVER parses \x01.
    //
    // TRAP (#638): /ping NickServ now CORRELATES (token-less service PING replies
    // resolve), so a PING fixture would be consumed upstream and never reach this
    // render — green for the WRONG reason. VERSION/TIME have NO correlation
    // machinery: they are the genuinely uncorrelated class this fix must cover.
    const ctcpNotice: ScrollbackMessage[] = [
      {
        id: 1,
        network: "freenode",
        channel: "#grappa",
        server_time: 1,
        kind: "notice",
        sender: "bob",
        body: "\x01VERSION irssi 1.4.5\x01",
        meta: { ctcp_verb: "VERSION", ctcp_args: "irssi 1.4.5" },
      },
      {
        id: 2,
        network: "freenode",
        channel: "#grappa",
        server_time: 2,
        kind: "notice",
        sender: "someclient",
        body: "\x01TIME Sat Aug 02 2026\x01",
        meta: { ctcp_verb: "TIME", ctcp_args: "Sat Aug 02 2026" },
      },
    ];
    setScrollback({ "freenode #grappa": ctcpNotice });
    render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
    const lines = screen.getAllByTestId("scrollback-line");
    expect(lines).toHaveLength(2);
    // Human INBOUND line from typed meta: direction ← and "reply from <sender>",
    // reply payload (ctcp_args) rendered irssi-style after the sender.
    expect(lines[0]?.dataset.kind).toBe("notice");
    expect(lines[0]).toHaveTextContent("← CTCP VERSION reply from bob");
    expect(lines[0]).toHaveTextContent("irssi 1.4.5");
    // THE DEFECT: raw \x01 (U+0001) must NEVER reach the DOM.
    expect(lines[0]?.textContent ?? "").not.toContain("\x01");
    // General class, not the /ping instance: a stray TIME reply too.
    expect(lines[1]).toHaveTextContent("← CTCP TIME reply from someclient");
    expect(lines[1]).toHaveTextContent("Sat Aug 02 2026");
    expect(lines[1]?.textContent ?? "").not.toContain("\x01");
  });

  it("scrubs an INTERIOR \\x01 the server's one-trailing-strip left in typed CTCP meta — #641", () => {
    // The server's SSOT classifier (Grappa.IRC.CTCP.verb_args/1) strips only the
    // ONE optional TRAILING \x01, so a malformed or concatenated frame
    // (`\x01VERSION a\x01b\x01`, `\x01V x\x01\x01PING y\x01`) leaves an INTERIOR
    // \x01 in the TYPED verb/args. The plain not.toContain check on a clean
    // payload passes trivially; this fixture carries the delimiter INSIDE the
    // typed strings, so it goes red if the render stops scrubbing them. "cic
    // NEVER shows \x01" is absolute — the fix must hold for adversarial input,
    // not just a well-formed reply.
    const adversarial: ScrollbackMessage[] = [
      {
        id: 1,
        network: "freenode",
        channel: "#grappa",
        server_time: 1,
        kind: "notice",
        sender: "mallory",
        // verb + args each carry an interior delimiter (verb_args left them in).
        body: "\x01VE\x01RSION 1.0\x01evil\x01",
        meta: { ctcp_verb: "VE\x01RSION", ctcp_args: "1.0\x01evil" },
      },
      // The privmsg CTCP arm shares the same scrub (fix the class): an operator's
      // own echo with a stray delimiter must not leak it either.
      {
        id: 2,
        network: "freenode",
        channel: "#grappa",
        server_time: 2,
        kind: "privmsg",
        sender: "alice",
        body: "\x01PING to\x01ken\x01",
        meta: { ctcp_verb: "PING", ctcp_args: "to\x01ken", ctcp_target: "bob" },
      },
    ];
    setScrollback({ "freenode #grappa": adversarial });
    render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
    const lines = screen.getAllByTestId("scrollback-line");
    expect(lines).toHaveLength(2);
    // Delimiters scrubbed from BOTH verb and args; NO U+0001 in the DOM.
    expect(lines[0]).toHaveTextContent("← CTCP VERSION reply from mallory: 1.0evil");
    expect(lines[0]?.textContent ?? "").not.toContain("\x01");
    expect(lines[1]).toHaveTextContent("→ CTCP PING token to bob");
    expect(lines[1]?.textContent ?? "").not.toContain("\x01");
  });

  it("renders the action row with one space between '*' and the nick (not two) — #457", () => {
    // Regression pin for #457: the :action arm rendered `*  nick` (two
    // spaces) while every sibling `*`-framed kind (join/part/quit/…) uses
    // the one-space `* ` chrome. The other action assertions above go
    // through toHaveTextContent, which normalises whitespace, so the double
    // space was silently untested. Assert the RAW textContent so the shared
    // `* ` convention is pinned on the action row either way.
    setScrollback({ "freenode #grappa": fixture });
    render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
    const actionLine = screen
      .getAllByTestId("scrollback-line")
      .find((l) => l.dataset.kind === "action");
    expect(actionLine).toBeDefined();
    // textContent is `HH:MM:SS * bob waves` (the timestamp gutter prefixes
    // every line), so assert on the `*`-to-body segment, not the whole string.
    const text = actionLine?.textContent ?? "";
    expect(text).toContain("* bob waves");
    expect(text).not.toContain("*  ");
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

  it("renders an own-nick user-MODE row on $server as 'sets user mode' with no channel suffix (#154b)", () => {
    // EventRouter's user-MODE-on-self branch persists every own-nick mode
    // transition (+iS/+ixS at connect, +r at IDENTIFY, +a from services) to
    // the synthetic "$server" window. A user-mode has no channel, so the
    // mode arm keys off channel === SERVER_WINDOW_NAME to render "sets user
    // mode +x" and drop the "on <channel>" suffix that channel MODEs carry.
    const rows: ScrollbackMessage[] = [
      {
        id: 1,
        network: "n",
        channel: "$server",
        server_time: 1,
        kind: "mode",
        sender: "mez",
        body: null,
        meta: { modes: "+a", args: [] },
      },
    ];
    setScrollback({ "n $server": rows });
    render(() => <ScrollbackPane networkSlug="n" channelName="$server" kind="server" />);
    const lines = screen.getAllByTestId("scrollback-line");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent("mez");
    expect(lines[0]).toHaveTextContent("sets user mode +a");
    // Must NOT paint the channel-MODE "on <channel>" suffix.
    expect(lines[0]).not.toHaveTextContent("on $server");
    expect(lines[0]).not.toHaveTextContent("<mez>");
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

    // #370 — a message matching a CUSTOM highlight word (from /hilight) must
    // get the SAME in-place visual emphasis an own-nick mention gets: the
    // SAME classes fire, so the CSS is byte-identical. Before #370 the visual
    // matcher only ever saw the own nick, so a custom-word line rendered plain
    // even though the (server-side) notification fired.
    it("adds .scrollback-mention AND .scrollback-highlight to a privmsg matching a custom highlight word", () => {
      setUserNick("vjt");
      setHighlightPatternsForTest(["deploy"]);
      setScrollback({
        "freenode #a": [
          {
            id: 1,
            network: "freenode",
            channel: "#a",
            server_time: 100,
            kind: "privmsg",
            sender: "alice",
            // NO own nick — the highlight is driven purely by the custom word.
            body: "the deploy is done",
            meta: {},
          },
        ],
      });
      const { container } = render(() => (
        <ScrollbackPane networkSlug="freenode" channelName="#a" kind="channel" />
      ));
      const line = container.querySelector('[data-kind="privmsg"]');
      expect(line?.classList.contains("scrollback-mention")).toBe(true);
      expect(line?.classList.contains("scrollback-highlight")).toBe(true);
    });

    it("custom-word match is case-insensitive and word-boundary bounded", () => {
      setUserNick("vjt");
      setHighlightPatternsForTest(["deploy"]);
      setScrollback({
        "freenode #a": [
          {
            id: 1,
            network: "freenode",
            channel: "#a",
            server_time: 100,
            kind: "privmsg",
            sender: "alice",
            body: "DEPLOY finished",
            meta: {},
          },
          {
            id: 2,
            network: "freenode",
            channel: "#a",
            server_time: 101,
            kind: "privmsg",
            sender: "alice",
            // substring inside a larger word → not a match
            body: "deployment scheduled",
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#a" kind="channel" />);
      const lines = screen.getAllByTestId("scrollback-line");
      expect(lines[0]?.classList.contains("scrollback-highlight")).toBe(true);
      expect(lines[1]?.classList.contains("scrollback-highlight")).toBe(false);
      expect(lines[1]?.classList.contains("scrollback-mention")).toBe(false);
    });

    it("with NO custom patterns configured, a non-nick line stays a plain row", () => {
      // Regression guard: the empty pattern list must not spuriously highlight.
      setUserNick("vjt");
      setHighlightPatternsForTest([]);
      setScrollback({
        "freenode #a": [
          {
            id: 1,
            network: "freenode",
            channel: "#a",
            server_time: 100,
            kind: "privmsg",
            sender: "alice",
            body: "the deploy is done",
            meta: {},
          },
        ],
      });
      const { container } = render(() => (
        <ScrollbackPane networkSlug="freenode" channelName="#a" kind="channel" />
      ));
      const line = container.querySelector('[data-kind="privmsg"]');
      expect(line?.classList.contains("scrollback-mention")).toBe(false);
      expect(line?.classList.contains("scrollback-highlight")).toBe(false);
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

  // C7.1: Day-separator lines. #422 Part 2: the FIRST rendered row now
  // always carries a leading day-separator (labeled from its own
  // `server_time`), so a window opened out of the Archive holding a single
  // old message shows the date instead of a bare `HH:MM`.
  describe("day-separator lines (C7.1)", () => {
    it("renders a leading day-separator before the first row even when all messages share a day (#422)", () => {
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
      // Exactly one separator (the leading one) — same-day rows add no more.
      expect(screen.getAllByTestId("day-separator")).toHaveLength(1);
      const sep = screen.getByTestId("day-separator");
      expect(sep.textContent?.trim()).toBeTruthy();
      // It precedes the first message row in DOM order.
      const [firstLine] = screen.getAllByTestId("scrollback-line");
      expect(firstLine).toBeDefined();
      if (firstLine) {
        expect(
          sep.compareDocumentPosition(firstLine) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
    });

    it("labels the leading separator from a lone archived message's day (#422 archive case)", () => {
      const loneOldMsg: ScrollbackMessage[] = [
        {
          id: 1,
          network: "freenode",
          channel: "peer",
          server_time: 1_700_000_000_000,
          kind: "privmsg",
          sender: "peer",
          body: "old DM, no date before #422",
          meta: {},
        },
      ];
      setScrollback({ "freenode peer": loneOldMsg });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="peer" kind="query" />);
      expect(screen.getAllByTestId("day-separator")).toHaveLength(1);
      expect(screen.getByTestId("day-separator").textContent?.trim()).toBeTruthy();
    });

    it("renders a leading + a between separator for messages on different days", () => {
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
      // #422: leading separator (day1) + the between separator (day2) = 2.
      const separators = screen.getAllByTestId("day-separator");
      expect(separators).toHaveLength(2);
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
      // #422: leading separator + 2 between-day separators = 3.
      const separators = screen.getAllByTestId("day-separator");
      expect(separators).toHaveLength(3);
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

  // #608 — CHARACTERIZATION of the geometric at-bottom → button contract, ahead
  // of the `atBottom` → `followMode` + `atBottomNow` split (deep-review §6.1).
  // jsdom has no layout, but `onScroll`'s distance is pure arithmetic over
  // scrollTop/scrollHeight/clientHeight, so `defineProperty`'d geometry + a
  // dispatched `scroll` event exercises the EXACT branches the split touches:
  // `onScroll`'s at-bottom flip and the floating button's `<Show>` read. The
  // full scroll physics live in the chromium e2e (issue280/289,
  // login-advanced-scroll-reachability — webkit ≠ iOS scroll,
  // feedback_playwright_webkit_not_ios_scroll); this locks the unit-observable
  // half so the split (which moves the button onto `atBottomNow` and the
  // tail-follow onto `followMode`) cannot silently regress the button. These
  // assert CURRENT behavior and MUST stay green verbatim across the split.
  describe("#608 — floating button tracks the geometric at-bottom state", () => {
    const overflowing = (list: HTMLDivElement, scrollTop: number): void => {
      Object.defineProperty(list, "scrollHeight", { value: 5000, configurable: true });
      Object.defineProperty(list, "clientHeight", { value: 500, configurable: true });
      Object.defineProperty(list, "scrollTop", {
        value: scrollTop,
        writable: true,
        configurable: true,
      });
    };

    it("surfaces the button on an operator scroll-up and hides it again at the tail", async () => {
      setScrollback({ "freenode #grappa": fixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const list = screen.getByTestId("scrollback") as HTMLDivElement;

      // At the tail (initial state) → no button.
      expect(screen.queryByTestId("scroll-to-bottom")).toBeNull();

      // Scroll DOWN first (establishes lastScrollTop), then UP: the follow
      // authority flips false ONLY when scrollTop DECREASES (the #168 guard).
      overflowing(list, 400);
      list.dispatchEvent(new Event("scroll"));
      list.scrollTop = 100; // distance 5000-100-500 = 4400 > 50 AND 100 < 400 → scroll-up
      list.dispatchEvent(new Event("scroll"));
      await waitFor(() => {
        expect(screen.queryByTestId("scroll-to-bottom")).not.toBeNull();
      });

      // Return to the tail → button hides again (distance within threshold).
      list.scrollTop = 4500; // distance 5000-4500-500 = 0 <= 50 → reach-tail
      list.dispatchEvent(new Event("scroll"));
      await waitFor(() => {
        expect(screen.queryByTestId("scroll-to-bottom")).toBeNull();
      });
    });

    it("keeps the button hidden on a content-grow above the fold (scrollTop not decreased — #168)", async () => {
      setScrollback({ "freenode #grappa": fixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const list = screen.getByTestId("scrollback") as HTMLDivElement;

      // Following the tail (distance 0 → at bottom, button hidden).
      overflowing(list, 4500);
      list.dispatchEvent(new Event("scroll"));
      expect(screen.queryByTestId("scroll-to-bottom")).toBeNull();

      // Older rows PREPEND above the viewport: scrollHeight grows, scrollTop is
      // unchanged. The scroll event this fires shows a huge distance-to-tail, but
      // scrollTop did NOT decrease → the follow state must NOT flip (#168), so the
      // button stays hidden. Were the guard removed, distance>threshold would
      // surface the button here.
      Object.defineProperty(list, "scrollHeight", { value: 8000, configurable: true });
      list.dispatchEvent(new Event("scroll")); // distance 8000-4500-500 = 3000 > 50, but 4500 !< 4500
      await new Promise((r) => queueMicrotask(() => r(undefined)));
      expect(screen.queryByTestId("scroll-to-bottom")).toBeNull();
    });
  });

  // #608 step 4 (characterization for the applier funnel) — the POST-AWAIT
  // loadMore preserve (W6). When older rows PREPEND (scrollHeight grows),
  // scrollTop shifts by the growth so the reader's on-screen row stays fixed:
  // `newScrollHeight - oldScrollHeight + oldScrollTop`. Pinned in jsdom over
  // defineProperty'd geometry (the e2e twins are cp14-b2 +
  // issue230-wheel-underfill-loadmore); this locks the height-delta math
  // observably BEFORE the applier extracts it into the distinct post-await
  // `applyPrependPreserve` entrypoint. Asserts CURRENT behavior.
  describe("#608 — loadMore preserve restores position via the prepend height delta", () => {
    let origScrollIntoView: typeof Element.prototype.scrollIntoView;
    beforeEach(() => {
      // The tail-follow fallback is `scrollTop = scrollHeight` ONLY when
      // scrollIntoView is absent (jsdom's default). Stub it as a no-op so the
      // mount tail-follow authority never touches scrollTop — isolating the W6
      // height-delta restore under test (else the mount rAF×2 tail overwrites
      // the restore with scrollHeight, since followMode defaults true).
      origScrollIntoView = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = vi.fn();
    });
    afterEach(() => {
      Element.prototype.scrollIntoView = origScrollIntoView;
    });

    it("shifts scrollTop by the prepend height growth, preserving the reader's row", async () => {
      setScrollback({ "freenode #grappa": fixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const list = screen.getByTestId("scrollback") as HTMLDivElement;

      // Near the top (scrollTop 40 <= LOAD_MORE_THRESHOLD_PX 200) so onScroll
      // fires maybeLoadOlder; overflowing so distance is large (no tail flip,
      // and 40 is not a decrease from lastScrollTop 0 → followMode untouched).
      Object.defineProperty(list, "clientHeight", { value: 300, configurable: true });
      Object.defineProperty(list, "scrollTop", { value: 40, writable: true, configurable: true });
      Object.defineProperty(list, "scrollHeight", { value: 1000, configurable: true });

      // loadMore resolves AND simulates the prepend (scrollHeight 1000 → 1500).
      vi.mocked(loadMore).mockImplementationOnce(() => {
        Object.defineProperty(list, "scrollHeight", { value: 1500, configurable: true });
        return Promise.resolve();
      });

      list.dispatchEvent(new Event("scroll"));

      // Post-await restore: 1500 - 1000 + 40 = 540 (the reader's row held).
      await waitFor(() => expect(list.scrollTop).toBe(540));
    });
  });

  // #608 step 3 (characterization for the applier funnel) — the W9 smooth-scroll
  // interrupt. The mention-jump is the ONE animated scroll in this pane; a
  // channel switch must cancel any in-flight animation (the shared `.scrollback`
  // DOM survives the row swap, so a live animation would race the arriving
  // pane's activation). The cancel is a `scrollTo` to the CURRENT offset — an
  // instant scroll instruction that stops the native smooth animation without
  // moving. Pinned here BEFORE the applier extracts it into `interruptSmoothScroll`.
  describe("#608 — key switch interrupts an in-flight smooth scroll (W9)", () => {
    it("calls scrollTo to the current offset on a channel switch", async () => {
      const scrollToSpy = vi.fn();
      const [chan, setChan] = createSignal("#a");
      setScrollback({ "freenode #a": fixture, "freenode #b": fixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName={chan()} kind="channel" />);
      const list = screen.getByTestId("scrollback") as HTMLDivElement;
      // jsdom leaves scrollTo undefined; assign a spy on this instance (the
      // .scrollback node is stable across the non-keyed channel↔query switch).
      list.scrollTo = scrollToSpy;
      Object.defineProperty(list, "scrollTop", { value: 123, writable: true, configurable: true });
      scrollToSpy.mockClear();

      // Switch channels → key() changes → the interrupt (a deferred on(key)
      // effect) fires synchronously, reading the current scrollTop.
      setChan("#b");
      await Promise.resolve();

      expect(scrollToSpy).toHaveBeenCalledWith({ top: 123 });
    });
  });

  // #608 step 3 (characterization for the applier funnel) — the W8 mention-jump.
  // Tapping the floating button when a mention sits below the fold smooth-scrolls
  // the anchor into view (`scrollIntoView({behavior:"smooth", block:"center"})`)
  // instead of jumping to the tail. Pinned here BEFORE the applier routes it
  // through a `mention-jump` one-shot intent. jsdom has no layout, so the mention
  // row's offsetTop is faked (readMentionGeom reads offsetTop) — the REAL
  // mentionsBelowViewport / mentionJumpTargetId then classify it below the fold,
  // no shared-mock swap needed.
  describe("#608 — mention-jump smooth-scrolls the anchor (W8)", () => {
    it("smooth-scrolls the mention anchor into view on a tap with a mention below", async () => {
      setUserNick("vjt");
      // A peer privmsg mentioning "vjt" gets .scrollback-mention; it is the LAST
      // row, so mentionJumpTargetId returns its own id (anchor = the mention row).
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1,
            kind: "privmsg",
            sender: "alice",
            body: "hi",
            meta: {},
          },
          {
            id: 2,
            network: "freenode",
            channel: "#grappa",
            server_time: 2,
            kind: "privmsg",
            sender: "bob",
            body: "hey vjt",
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const list = screen.getByTestId("scrollback") as HTMLDivElement;

      // Overflowing; the mention row (id 2) sits far below the fold (offsetTop
      // 1500 >> viewportBottom). scrollTop starts at 400 for the scroll-up below.
      Object.defineProperty(list, "clientHeight", { value: 100, configurable: true });
      Object.defineProperty(list, "scrollHeight", { value: 2000, configurable: true });
      Object.defineProperty(list, "scrollTop", { value: 400, writable: true, configurable: true });
      const mentionRow = list.querySelector<HTMLElement>('.scrollback-line[data-msg-id="2"]');
      if (mentionRow === null) throw new Error("mention row not rendered");
      Object.defineProperty(mentionRow, "offsetTop", { value: 1500, configurable: true });
      const scrollIntoViewSpy = vi.fn();
      mentionRow.scrollIntoView = scrollIntoViewSpy;

      // Scroll DOWN (establishes lastScrollTop) then UP → atBottomNow false, so
      // the floating button renders. followMode also flips false, so the mount
      // tail-follow bails (never touches the spied row).
      list.dispatchEvent(new Event("scroll"));
      list.scrollTop = 200;
      list.dispatchEvent(new Event("scroll"));
      await waitFor(() => expect(screen.queryByTestId("scroll-to-bottom")).not.toBeNull());
      scrollIntoViewSpy.mockClear();

      // Tap the button → mention path: viewportBottom = 200+100 = 300, the
      // mention (offsetTop 1500) is below it → smooth-scroll the anchor.
      screen.getByTestId("scroll-to-bottom").click();

      expect(scrollIntoViewSpy).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    });
  });

  // #608 step 3 (characterization for the applier funnel) — the W2/W3
  // `scrollToActivation` CALL-SITES (cold-mount, channel switch, visibility-
  // return, resize). They are about to be routed through a thin
  // `applyActivation(mode, withHide)` entrypoint that resolves the
  // overlay-freeze ▸ activation precedence via `resolveIntent` and delegates to
  // `scrollToActivation` ONLY when the activation kind wins — behaviour-identical
  // because `scrollToActivation` already bails on `isOverlayFrozen()` (so the
  // overlay-freeze-wins branch is the same no-op either way). These pin the
  // CURRENT call-site behaviour observably BEFORE the extraction:
  //   * a channel switch still scrolls the ARRIVING pane — isolable: #a and #b
  //     have the same row count, so `rows().length` is unchanged and the
  //     length-effect does NOT fire; only the key-effect activation can move it.
  //   * a cold mount into an unread window still jumps to the frozen divider
  //     (the #168 marker branch — `block: "start"`), EXACT.
  // The frozen-no-op HALF is already locked by the #219-general resize cases
  // (`a resize WHILE a covering overlay is open does NOT snap to the tail`),
  // which post-refactor exercise `applyActivation`'s overlay-freeze gate.
  describe("#608 — activation call-sites fire the activation scroll (W2/W3)", () => {
    let scrollIntoViewSpy: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      scrollIntoViewSpy = vi.fn();
      // biome-ignore lint/suspicious/noExplicitAny: jsdom Element type compat
      (Element.prototype as any).scrollIntoView = scrollIntoViewSpy;
    });
    // rAF drain — scrollToActivation schedules its scroll inside a double-rAF
    // (geometry-after-layout idiom); mirrors the #219-general block's helper.
    const flushRaf = async (): Promise<void> => {
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r(undefined))),
      );
    };

    it("a channel switch fires the arriving pane's activation tail scroll", async () => {
      const [chan, setChan] = createSignal("#a");
      setScrollback({ "freenode #a": fixture, "freenode #b": fixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName={chan()} kind="channel" />);
      const list = screen.getByTestId("scrollback") as HTMLDivElement;
      // jsdom leaves scrollTo undefined; the W9 key-change interrupt effect
      // (interruptSmoothScroll) calls it on the switch. Stub a no-op so the
      // switch completes (the .scrollback node is stable across the switch).
      list.scrollTo = vi.fn();
      await flushRaf();
      // #b has the SAME row count as #a → rows().length unchanged → the
      // length-effect does NOT fire; only the key-effect activation moves the
      // arriving pane. Isolates the W2/W3 call-site from the length-effect funnel.
      scrollIntoViewSpy.mockClear();

      setChan("#b");
      await flushRaf();

      // No cursor on #b → no divider → the marker-or-tail activation tails.
      expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: "end" });
    });

    it("a cold mount into an unread window jumps to the frozen divider (#168 marker branch)", async () => {
      // Cursor mid-list (id 1) → ids 2,3 unread → the rows() memo injects the
      // divider, and the cold-mount marker-or-tail activation scrolls to it
      // (block: "start"), NOT the tail.
      seedReadCursor("freenode", "#grappa", 1);
      setScrollback({ "freenode #grappa": fixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      await flushRaf();

      expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: "start" });
    });
  });

  // #608 STEP 5 (RED-GREEN behaviour change) — the SEND submit path ARMS the
  // follow INTENT; it does NOT synchronously scroll to a non-existent node. The
  // WS echo row is not in the DOM at submit (scrollback.ts publishes
  // ownSendSubmitted SYNC before the POST — no optimistic append), so the old
  // scrollToBottom() read PRE-append geometry and scrolled to the STALE tail
  // (the #608 §5 off-by-one). Reshaped: submit sets followMode via nextFollowMode
  // "send" (+ releases the marker latch); the applier tail-follows when the echo
  // row mounts. followMode/atBottomNow first DIVERGE here — followMode is armed at
  // submit; atBottomNow only flips once the echo lays out. e2e twin:
  // issue580-send-snap-independent-of-post (asserts the end-state snap after the
  // WS echo, which this reshape preserves — the follow-arm is independent of the
  // POST, the tail fires on the WS echo).
  describe("#608 — send arms followMode without scrolling the pre-echo tail (STEP 5)", () => {
    let origScrollIntoView: typeof Element.prototype.scrollIntoView;
    let scrollIntoViewSpy: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      origScrollIntoView = Element.prototype.scrollIntoView;
      scrollIntoViewSpy = vi.fn();
      // biome-ignore lint/suspicious/noExplicitAny: jsdom Element type compat
      (Element.prototype as any).scrollIntoView = scrollIntoViewSpy;
    });
    afterEach(() => {
      Element.prototype.scrollIntoView = origScrollIntoView;
    });
    const overflowing = (list: HTMLDivElement, scrollTop: number): void => {
      Object.defineProperty(list, "scrollHeight", { value: 5000, configurable: true });
      Object.defineProperty(list, "clientHeight", { value: 500, configurable: true });
      Object.defineProperty(list, "scrollTop", {
        value: scrollTop,
        writable: true,
        configurable: true,
      });
    };
    const flushRaf = async (): Promise<void> => {
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r(undefined))),
      );
    };

    it("submit does NOT scroll the stale pre-echo tail; it arms followMode so the applier tails when the echo mounts", async () => {
      setScrollback({ "freenode #grappa": fixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const list = screen.getByTestId("scrollback") as HTMLDivElement;

      // Operator scrolls UP → followMode flips false (scroll DOWN then UP; the
      // #168 guard: followMode leaves the tail only when scrollTop DECREASES).
      overflowing(list, 400);
      list.dispatchEvent(new Event("scroll"));
      list.scrollTop = 100;
      list.dispatchEvent(new Event("scroll"));
      await waitFor(() => expect(screen.queryByTestId("scroll-to-bottom")).not.toBeNull());
      await flushRaf();
      scrollIntoViewSpy.mockClear();

      // SUBMIT — no echo row appended yet (WS-driven render; ownSendSubmitted is
      // published SYNC before the POST in production).
      pushOwnSendSubmitted("freenode #grappa");
      await Promise.resolve();
      await flushRaf();

      // Reshaped: no scroll to the stale tail at submit. (RED pre-reshape: the
      // submit effect's scrollToBottom() fired scrollIntoView on the OLD tail.)
      expect(scrollIntoViewSpy).not.toHaveBeenCalled();

      // The WS echo lands (rows 3 → 4) AND lays out (the extent grows + the new
      // tail row gains a box). followMode was ARMED at submit, so the applier's
      // length-effect tail-follows once the measured settle holds (#608 STEP 6).
      const proto = fixture[0];
      if (!proto) throw new Error("fixture[0] missing");
      setScrollback({
        "freenode #grappa": [
          ...fixture,
          { ...proto, id: 4, server_time: 1_700_000_003_000, sender: "vjt", body: "my echo" },
        ],
      });
      Object.defineProperty(list, "scrollHeight", { value: 5200, configurable: true });
      Object.defineProperty(list.lastElementChild as HTMLElement, "offsetHeight", {
        value: 20,
        configurable: true,
      });
      await flushRaf();
      expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: "end" });
    });
  });

  // #608 STEP 5b (characterization for the gesture migration) — the explicit
  // scroll-to-bottom GESTURE (floating button / #243 re-tap) performs an INSTANT
  // tail scrollIntoView. It is about to be routed through an operator-tail applier
  // intent (the write moved into `dispatchScrollWrite` so no raw scrollIntoView
  // lives OUTSIDE the applier surface). This pins the CURRENT sync tail write
  // observably BEFORE the extraction; behaviour-identical (mirrors the W8
  // mention-jump migration — a single-intent one-shot, fired unconditionally).
  // Driven via the #243 re-tap command — the SAME `scrollToBottomGesture` the
  // floating button's onClick invokes (jsdom's zero-geometry keeps the button
  // unmounted, so the command is the harness for the shared gesture).
  describe("#608 — scroll-to-bottom gesture performs an operator-tail write (STEP 5b)", () => {
    let origScrollIntoView: typeof Element.prototype.scrollIntoView;
    let scrollIntoViewSpy: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      origScrollIntoView = Element.prototype.scrollIntoView;
      scrollIntoViewSpy = vi.fn();
      // biome-ignore lint/suspicious/noExplicitAny: jsdom Element type compat
      (Element.prototype as any).scrollIntoView = scrollIntoViewSpy;
    });
    afterEach(() => {
      Element.prototype.scrollIntoView = origScrollIntoView;
    });

    it("the #243 re-tap gesture instant-scrolls the tail into view", async () => {
      setScrollback({ "freenode #grappa": fixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      await waitFor(() => expect(screen.getAllByTestId("scrollback-line")).toHaveLength(3));
      // Drain the mount tail-follow so only the gesture's write is observed.
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r(undefined))),
      );
      scrollIntoViewSpy.mockClear();

      // THE GESTURE — the #243 re-tap command the floating button's onClick shares.
      requestScrollToBottom();
      await Promise.resolve();

      expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: "end" });
    });
  });

  // #608 STEP 6 (RED-GREEN behaviour change) — the tail-follow write waits for a
  // MEASURED settle (isSettled: the appended content's extent has GROWN vs the
  // last tail AND the new tail row has a laid-out box) before scrolling, instead
  // of a fixed rAF×2 — which is not a layout flush on iOS WebKit and scrolled to
  // the STALE pre-layout tail (the #608 §5 off-by-one). The pure isSettled core
  // is unit-tested in scrollAuthority.test.ts; this pins the WIRING: no scroll on
  // stale geometry, then a scroll the frame the row lays out. e2e wiring =
  // chromium bug7-ios-own-msg-visible (STRENGTHENED); real-iOS = device verify.
  describe("#608 — tail-follow waits for measured settle before scrolling (STEP 6)", () => {
    let origScrollIntoView: typeof Element.prototype.scrollIntoView;
    let scrollIntoViewSpy: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      // The module-level readCursorStore is NOT reset by the global beforeEach,
      // so a prior test's seeded cursor leaks in; on a clean-cursor pane it would
      // render an unread marker and the echo append below would fire a
      // marker-activation scroll (block:"start"), polluting the "no scroll on
      // stale geometry" assertion. Reset it here (mirrors the #219-general block's
      // own resetOverlayLock) so this test owns a no-cursor baseline.
      setReadCursorStore({});
      origScrollIntoView = Element.prototype.scrollIntoView;
      scrollIntoViewSpy = vi.fn();
      // biome-ignore lint/suspicious/noExplicitAny: jsdom Element type compat
      (Element.prototype as any).scrollIntoView = scrollIntoViewSpy;
    });
    afterEach(() => {
      Element.prototype.scrollIntoView = origScrollIntoView;
    });
    const oneFrame = async (): Promise<void> => {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    };
    const flushFrames = async (n: number): Promise<void> => {
      for (let i = 0; i < n; i += 1) await oneFrame();
    };
    const setBox = (el: Element | null, px: number): void => {
      if (el) Object.defineProperty(el, "offsetHeight", { value: px, configurable: true });
    };

    it("does not tail-follow on stale pre-layout geometry; scrolls once scrollHeight grows and the row has a box", async () => {
      setScrollback({ "freenode #grappa": fixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const list = screen.getByTestId("scrollback") as HTMLDivElement;

      // Baseline: mount at the tail with a real extent + a laid-out tail row so
      // the mount tail-follow SETTLES (establishes lastTailScrollHeight = 1000).
      Object.defineProperty(list, "scrollHeight", {
        value: 1000,
        writable: true,
        configurable: true,
      });
      setBox(list.lastElementChild, 18);
      await flushFrames(3);
      scrollIntoViewSpy.mockClear();

      // Echo appends (rows 3 → 4). Simulate iOS: the new row is COMMITTED but not
      // laid out — scrollHeight is STALE (still 1000) and the new tail's box is 0.
      const proto = fixture[0];
      if (!proto) throw new Error("fixture[0] missing");
      setScrollback({
        "freenode #grappa": [
          ...fixture,
          { ...proto, id: 4, server_time: 1_700_000_003_000, sender: "vjt", body: "echo" },
        ],
      });
      await flushFrames(3);

      // NOT settled (scrollHeight has not grown, new tail box is 0) → no scroll.
      // RED pre-STEP-6: the fixed rAF×2 scrolled here regardless of layout.
      expect(scrollIntoViewSpy).not.toHaveBeenCalled();

      // Layout lands: the extent grows AND the new tail row gains a box.
      Object.defineProperty(list, "scrollHeight", { value: 1200, configurable: true });
      setBox(list.lastElementChild, 18);
      await flushFrames(3);

      expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: "end" });
    });
  });

  // #310 — the scroll-to-bottom GESTURE (floating button + #243 re-tap)
  // must advance the server read cursor to the NEWEST rendered message.
  // Pre-#310 both funnelled through the pure `scrollToBottom()` helper,
  // which never POSTed a cursor advance — so reaching the bottom did not
  // persist "read to newest", and a later marker re-assert snapped the
  // view back to the divider (~2s later; vjt prod report on #libera). The
  // gesture now runs the same "reached bottom → advance to newest" logic a
  // manual scroll does, capturing the tail id AFTER the (instant) scroll
  // via the shared forward-only `setCursorIfAdvances` path.
  //
  // jsdom is blind to scroll geometry — the button only renders when
  // `!atBottom()`, which never happens under jsdom's zero-geometry — so this
  // drives the SHARED gesture through the #243 re-tap command
  // (`requestScrollToBottom`), the same `scrollToBottomGesture` the button's
  // onClick invokes. The real button DOM tap + the no-snap-back proof live
  // in the issue310 Playwright spec (jsdom can't reproduce the scroll).
  describe("#310 — scroll-to-bottom gesture advances the read cursor", () => {
    it("advances the read cursor to the newest rendered message id on a jump-to-bottom gesture", async () => {
      // Unread present: cursor mid-list at id 1 → ids 2 and 3 are unread.
      seedReadCursor("freenode", "#grappa", 1);
      setScrollback({ "freenode #grappa": fixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      // Pane mounted (the deferred re-tap effect is registered) and rows rendered.
      await waitFor(() => {
        expect(screen.getAllByTestId("scrollback-line")).toHaveLength(3);
      });

      // A bare mount/activation is a PROGRAMMATIC scroll — it must NOT advance
      // the cursor (that's the BUGHUNT-2 input-gate contract). Read here and
      // now: post-#887 the read-at-the-tail arm WILL advance it half a second
      // later on this jsdom pane (zero geometry reads as at-the-tail), which
      // is correct and unrelated — the claim being pinned is that the gesture
      // below is what does it, not the mount.
      expect(mockSetCursorIfAdvances).not.toHaveBeenCalled();

      // THE GESTURE: the jump-to-bottom command the floating button + the #243
      // re-tap share.
      requestScrollToBottom();

      // Reaching the bottom advances the cursor to the NEWEST rendered id (3),
      // read AFTER the scroll via lastFullyVisibleRowId's at-bottom short-circuit
      // (the true tail, never a stale pre-scroll id → no #233 clamp no-op).
      await waitFor(() => {
        expect(mockSetCursorIfAdvances).toHaveBeenCalledWith("freenode", "#grappa", 3);
      });
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
      // #740 — and the shared inline-button reset it now takes its shape
      // from. The CSS half is pinned in sharedButtonRules.test.ts; a rule
      // nothing wears is the #734 failure mode inverted.
      expect(sender?.classList.contains("scrollback-inline-button")).toBe(true);
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

    // #693 — a pane that gave up on contiguity and anchored at the tail.
    // The cursor is still set (and still server-authoritative), but it points
    // BELOW every loaded row, so the divider must stand down and the
    // boundary row must carry the true count instead.
    describe("far-behind boundary row (#693)", () => {
      afterEach(() => {
        setFarBehind({});
        jumpToUnreadSpy.mockClear();
        dismissFarBehindSpy.mockClear();
      });

      it("renders the jump affordance with the server's missed count", () => {
        seedReadCursor("freenode", "#grappa", 1);
        setScrollback({ "freenode #grappa": fixture });
        setFarBehind({ "freenode #grappa": { missed: 3000, resumeFrom: 1 } });
        render(() => (
          <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
        ));
        expect(screen.getByTestId("far-behind-jump")).toHaveTextContent("3000 unread");
      });

      it("suppresses the in-pane divider, whose count would describe the loaded rows", () => {
        // Without the suppression this pane shows "2 unread" — the loaded
        // rows past the cursor — while 3000 are actually missing.
        seedReadCursor("freenode", "#grappa", 1);
        setScrollback({ "freenode #grappa": fixture });
        setFarBehind({ "freenode #grappa": { missed: 3000, resumeFrom: 1 } });
        render(() => (
          <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
        ));
        expect(screen.queryByTestId("unread-marker")).toBeNull();
      });

      it("keeps the divider and shows no affordance for an ordinary pane", () => {
        seedReadCursor("freenode", "#grappa", 1);
        setScrollback({ "freenode #grappa": fixture });
        render(() => (
          <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
        ));
        expect(screen.queryByTestId("far-behind-jump")).toBeNull();
        expect(screen.getByTestId("unread-marker")).toHaveTextContent("2 unread");
      });

      it("does not leak another window's far-behind state into this pane", () => {
        seedReadCursor("freenode", "#grappa", 1);
        setScrollback({ "freenode #grappa": fixture });
        setFarBehind({ "freenode #other": { missed: 3000, resumeFrom: 1 } });
        render(() => (
          <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
        ));
        expect(screen.queryByTestId("far-behind-jump")).toBeNull();
        expect(screen.getByTestId("unread-marker")).toBeInTheDocument();
      });

      it("tapping it asks for the anchor region of THIS window", () => {
        seedReadCursor("freenode", "#grappa", 1);
        setScrollback({ "freenode #grappa": fixture });
        setFarBehind({ "freenode #grappa": { missed: 3000, resumeFrom: 1 } });
        render(() => (
          <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
        ));
        screen.getByTestId("far-behind-jump").click();
        expect(jumpToUnreadSpy).toHaveBeenCalledWith("freenode", "#grappa");
      });

      it("offers the dismiss exit — the only way past the frozen cursor", () => {
        // Without this the operator chats at the tail under a permanent
        // "3000 unread": far-behind freezes the read cursor, so no amount of
        // reading clears it.
        seedReadCursor("freenode", "#grappa", 1);
        setScrollback({ "freenode #grappa": fixture });
        setFarBehind({ "freenode #grappa": { missed: 3000, resumeFrom: 1 } });
        render(() => (
          <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
        ));
        screen.getByTestId("far-behind-dismiss").click();
        expect(dismissFarBehindSpy).toHaveBeenCalledWith("freenode", "#grappa");
      });

      it("dismissing does not leave a top-slammed divider behind", async () => {
        // The frozen `markerCursorId` snapshot is thousands of rows old. Un-
        // suppressing the marker without re-latching would draw "2 unread"
        // across the top of the buffer the instant the operator dismisses —
        // the wrong number the suppression existed to prevent.
        seedReadCursor("freenode", "#grappa", 1);
        setScrollback({ "freenode #grappa": fixture });
        setFarBehind({ "freenode #grappa": { missed: 3000, resumeFrom: 1 } });
        render(() => (
          <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
        ));
        screen.getByTestId("far-behind-dismiss").click();
        // The verb clears the flag server-side; mirror that here.
        setFarBehind({});
        await Promise.resolve();
        expect(screen.queryByTestId("unread-marker")).toBeNull();
      });

      it("renders the bar OUTSIDE the scroll list so a tail-anchored pane shows it", () => {
        // The pane opens at the BOTTOM (no divider to scroll to), so a row
        // in the scroll flow would sit viewports above the fold — the one
        // signal that a region was abandoned, where nobody looks.
        seedReadCursor("freenode", "#grappa", 1);
        setScrollback({ "freenode #grappa": fixture });
        setFarBehind({ "freenode #grappa": { missed: 3000, resumeFrom: 1 } });
        render(() => (
          <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
        ));
        const bar = screen.getByTestId("far-behind-bar");
        expect(screen.getByTestId("scrollback").contains(bar)).toBe(false);
      });
    });

    // #997 — the bar is pinned to the TOP edge, and the dismiss is the only
    // gesture that unfreezes the cursor. An operator sitting at the tail never
    // looked up: the frozen badge read as a broken counter for as long as they
    // used the client. The label stays where it is; the gesture also lands in
    // the #280 corner stack, where the thumb already is.
    describe("far-behind dismiss in thumb reach (#997)", () => {
      afterEach(() => {
        setFarBehind({});
        jumpToUnreadSpy.mockClear();
        dismissFarBehindSpy.mockClear();
      });

      const renderFarBehindPane = () => {
        seedReadCursor("freenode", "#grappa", 1);
        setScrollback({ "freenode #grappa": fixture });
        setFarBehind({ "freenode #grappa": { missed: 3000, resumeFrom: 1 } });
        render(() => (
          <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
        ));
      };

      it("puts the affordance in the corner stack, not only in the top bar", () => {
        renderFarBehindPane();
        const corner = screen.getByTestId("far-behind-float-dismiss");
        // Membership in the stack IS the reach fix: the stack is the
        // container-anchored lower-right cluster (#280), and a control outside
        // it inherits neither the anchor nor the pointer-events re-enable.
        expect(corner.parentElement?.className).toContain("scrollback-float-stack");
        expect(screen.getByTestId("far-behind-bar").contains(corner)).toBe(false);
      });

      it("shows nothing in the corner for an ordinary pane", () => {
        seedReadCursor("freenode", "#grappa", 1);
        setScrollback({ "freenode #grappa": fixture });
        render(() => (
          <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
        ));
        expect(screen.queryByTestId("far-behind-float-dismiss")).toBeNull();
      });

      it("dismisses THIS window's far-behind state, the same verb the × fires", () => {
        renderFarBehindPane();
        screen.getByTestId("far-behind-float-dismiss").click();
        expect(dismissFarBehindSpy).toHaveBeenCalledWith("freenode", "#grappa");
        // A corner control that navigated instead would leave the cursor
        // frozen — the badge would stay stuck with the way out now in reach
        // and still useless, which is worse than the reported defect.
        expect(jumpToUnreadSpy).not.toHaveBeenCalled();
      });

      it("re-latches the frozen divider, exactly as the × does", async () => {
        // The second surface must write the WHOLE state, not the part that is
        // easy to see. Dismissing without carrying the returned id back into
        // the frozen marker un-suppresses the divider against a cursor
        // snapshot thousands of rows old and slams "2 unread" across the top
        // of the buffer — the two controls would then disagree about what a
        // dismiss means.
        renderFarBehindPane();
        screen.getByTestId("far-behind-float-dismiss").click();
        // The verb clears the flag server-side; mirror that here.
        setFarBehind({});
        await Promise.resolve();
        expect(screen.queryByTestId("unread-marker")).toBeNull();
      });

      it("keeps the backwards jump on the bar — opposite directions survive", () => {
        // jump-to-first-unread goes BACKWARDS, scroll-to-bottom FORWARDS. The
        // corner gets the dismiss and ONLY the dismiss: a backwards jump one
        // gap above the forwards scroll would be the collision #280 anchored
        // this stack to prevent, and it would not unfreeze anything.
        renderFarBehindPane();
        expect(screen.getByTestId("far-behind-jump")).toBeInTheDocument();
        expect(
          screen.getByTestId("far-behind-bar").contains(screen.getByTestId("far-behind-jump")),
        ).toBe(true);
      });
    });

    // #947 — the notch after #693. The operator took the jump, so the flag is
    // gone and the divider is back; but the jump could only carry ONE page of
    // the gap, so counting the loaded rows reports the page size. The number
    // they tapped ("3000 unread — jump back") and the number they land on must
    // be the same number.
    describe("truncated unread region (#947)", () => {
      afterEach(() => setMeasuredUnread({}));

      it("labels the divider with the server's count, not the loaded rows", () => {
        seedReadCursor("freenode", "#grappa", 1);
        setScrollback({ "freenode #grappa": fixture });
        setMeasuredUnread({ "freenode #grappa": { at: 1, count: 3000 } });
        render(() => (
          <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
        ));
        expect(screen.getByTestId("unread-marker")).toHaveTextContent("3000 unread messages");
      });

      it("still PLACES the divider by the loaded rows", () => {
        // Only the label is carried. Placement stays loaded-row math — the
        // divider has to sit between the last read row and the first unread
        // row that is actually in the pane, and no server count can say where
        // that is.
        seedReadCursor("freenode", "#grappa", 1);
        setScrollback({ "freenode #grappa": fixture });
        setMeasuredUnread({ "freenode #grappa": { at: 1, count: 3000 } });
        render(() => (
          <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
        ));
        const flow = Array.from(
          screen
            .getByTestId("scrollback")
            .querySelectorAll('[data-testid="unread-marker"], .scrollback-line[data-msg-id]'),
        );
        const markerAt = flow.findIndex((n) => n.getAttribute("data-testid") === "unread-marker");
        expect(markerAt).toBeGreaterThan(0); // read context above it
        expect(flow[markerAt - 1]?.getAttribute("data-msg-id")).toBe(String(fixture[0]?.id));
        expect(flow[markerAt + 1]?.getAttribute("data-msg-id")).toBe(String(fixture[1]?.id));
      });

      it("ignores a measurement taken at a DIFFERENT cursor", () => {
        // Self-invalidating by construction: the count answers "how many rows
        // are after id 1", so it is meaningless once the divider re-freezes
        // somewhere else. Falling back to the loaded rows understates; reusing
        // a stale 3000 would be a confident wrong number that never expires.
        seedReadCursor("freenode", "#grappa", 1);
        setScrollback({ "freenode #grappa": fixture });
        setMeasuredUnread({ "freenode #grappa": { at: 999, count: 3000 } });
        render(() => (
          <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
        ));
        expect(screen.getByTestId("unread-marker")).toHaveTextContent("2 unread messages");
      });

      it("does not leak another window's measurement into this pane", () => {
        seedReadCursor("freenode", "#grappa", 1);
        setScrollback({ "freenode #grappa": fixture });
        setMeasuredUnread({ "freenode #other": { at: 1, count: 3000 } });
        render(() => (
          <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
        ));
        expect(screen.getByTestId("unread-marker")).toHaveTextContent("2 unread messages");
      });
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

    // #580 — the divider re-latch must stay bound to the CONFIRMED cursor
    // (post-POST `lastOwnSend`), NOT the submit-time snap signal. Model the
    // production timing: enter is pressed (submit fires) and the POST later
    // resolves + advances the LIVE cursor, but the frozen divider must not
    // move on the submit signal — else a send would clear the "unread" marker
    // reading a cursor before its own row was confirmed. This guards against
    // re-coupling the two concerns #580 deliberately split.
    it("submit-time signal does NOT re-latch the divider; only lastOwnSend does (#580 split)", async () => {
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

      // The POST resolves and advances the LIVE cursor to the sent row (13).
      // The frozen divider (markerCursorId, latched at mount to 9) must NOT
      // move on the submit-time signal — that signal owns only the network-
      // independent snap. If the re-latch were (wrongly) coupled to submit,
      // the divider would collapse here reading the advanced cursor.
      seedReadCursor("freenode", "#grappa", 13);
      pushOwnSendSubmitted("freenode #grappa");
      await new Promise((r) => queueMicrotask(() => r(undefined)));
      expect(screen.getByTestId("unread-marker")).toHaveTextContent("4 unread");

      // Only the post-resolve `lastOwnSend` re-latches the divider to the
      // confirmed cursor → it collapses.
      pushOwnSend("freenode #grappa");
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

    // #168 (2026-07-02): the unread divider is now DISPLAY-ONLY — it carries
    // no ref and is never a scroll anchor. The former REV-G `markerRef`
    // signal + scroll-to-marker branch (the SECOND scrollTop authority that
    // raced the tail-follow and yanked the view up on send) was removed; the
    // pane collapses to ONE always-bottom authority. This pins that a
    // mid-channel divider removal via focus re-acquisition re-activates the
    // pane cleanly and leaves it FOLLOWING the tail: atBottom stays true, so
    // the floating scroll-to-bottom button is not rendered (a regression that
    // reintroduced the marker anchor would set atBottom=false and surface the
    // button). Supersedes the REV-G H23 stale-ref pin — that bug class is now
    // structurally impossible (no ref exists).
    it("#168: divider removal on focus re-acquisition keeps the pane at the tail (display-only marker)", async () => {
      const { applyReadCursorSet } = await import("../lib/readCursor");
      const proto = fixture[0];
      if (!proto) throw new Error("fixture[0] missing");

      const fourUnread: ScrollbackMessage[] = [
        { ...proto, id: 50, server_time: 100, sender: "alice", body: "u1" },
        { ...proto, id: 51, server_time: 101, sender: "alice", body: "u2" },
        { ...proto, id: 52, server_time: 102, sender: "alice", body: "u3" },
        { ...proto, id: 53, server_time: 103, sender: "alice", body: "u4" },
      ];
      seedReadCursor("freenode", "#grappa", 0);
      setScrollback({ "freenode #grappa": fourUnread });
      setDocVisible(true);
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);

      // Divider present after mount (frozen-display contract).
      expect(screen.getByTestId("unread-marker")).toBeInTheDocument();

      // FREEZE CONTRACT (2026-06-08): a bare cursor advance no longer removes
      // the divider — it's frozen. The divider row unmounts when a FOCUS
      // acquisition re-latches the frozen boundary past the unread block.
      // Advance the live cursor, then drive ONE visibility-return: that
      // re-latches markerCursorId=53 → divider unmounts. (Yield between
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

      // A SECOND visibility-return re-activates the pane cleanly: divider
      // stays gone and the pane follows the tail (atBottom ⇒ the floating
      // scroll-to-bottom button is NOT rendered).
      setDocVisible(false);
      await new Promise((r) => queueMicrotask(() => r(undefined)));
      setDocVisible(true);
      await new Promise((r) => queueMicrotask(() => r(undefined)));
      expect(screen.queryByTestId("unread-marker")).toBeNull();
      expect(screen.queryByTestId("scroll-to-bottom")).toBeNull();
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
      // #740 — wears the shared inline-button reset beside its own class.
      expect(btn.classList.contains("scrollback-inline-button")).toBe(true);
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

    // #799 — a pre-#537 INVITE row still carries a mixed-case `params[1]`:
    // the ingress fold (EventRouter's `:invite` clause) IS the #537 fix, and
    // per the #525 posture `refold_identifiers_ascii` does NOT rewrite stored
    // values. Selection and `window_states` are keyed FOLDED, so focusing the
    // raw name opens a phantom pane the sidebar can't match. Same split as
    // every sibling (channelJoin.switchTo, compose.ts /join, DirectoryPane):
    // the KEY folds, the wire argument stays RAW.
    //
    // The folded expectation is a LITERAL, not `canonicalChannel(...)` —
    // routing both sides through the same helper would stay green if the
    // helper itself regressed. `#Sbiffo` → `#sbiffo` is the whole contract.
    const mixedCaseInviteRow: ScrollbackMessage = {
      ...inviteRow,
      id: 107,
      server_time: 107,
      body: "#Sbiffo",
      meta: {
        raw_verb: "INVITE",
        raw_sender: "vjt",
        raw_params: ["grappa", "#Sbiffo"],
      },
    };

    it("INVITE [Join] focuses the FOLDED channel while postJoin gets the RAW one (#799)", async () => {
      mockPostJoin.mockClear();
      mockSetSelectedChannel.mockClear();
      setScrollback({ "freenode $server": [mixedCaseInviteRow] });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="$server" kind="channel" />);
      const btn = document.querySelector(".scrollback-invite-join") as HTMLButtonElement;
      btn.click();
      await waitFor(() => {
        expect(mockSetSelectedChannel).toHaveBeenCalledWith({
          networkSlug: "freenode",
          channelName: "#sbiffo",
          kind: "channel",
        });
      });
      // The wire keeps the invite's spelling — the ircd does its own
      // casemapping, and cic never rewrites an outbound target.
      expect(mockPostJoin).toHaveBeenCalledWith("test-token", "freenode", "#Sbiffo", null);
    });

    it("INVITE row renders the RAW channel spelling as its label (#799)", () => {
      setScrollback({ "freenode $server": [mixedCaseInviteRow] });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="$server" kind="channel" />);
      expect(screen.getByTestId("scrollback-line").textContent).toContain("#Sbiffo");
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

  // #569 — numeric rows (meta.numeric, no raw_verb) render the WHOLE
  // param list, not just the trailing param. #424 already persists the
  // full list in meta.raw_params; the client discarded it, so every
  // numeric with a middle-param payload showed only its trailing token
  // (a column of `-1` for STATS Q-lines, an invisible cloak for 396).
  // raw_params[0] is the recipient's own nick on virtually every numeric
  // and is dropped, not printed. Per-numeric pretty arms grow
  // incrementally; the default joins the surviving params.
  describe("notice numeric raw-params rendering (#569)", () => {
    // Libera, 396 RPL_HOSTHIDDEN — the cloak is a MIDDLE param.
    // Wire: `:molybdenum.libera.chat 396 vjt-claude user/vjt-claude
    //        :is now your hidden host (set by services.)`
    const hostHiddenRow: ScrollbackMessage = {
      id: 300,
      network: "libera",
      channel: "$server",
      server_time: 300,
      kind: "notice",
      sender: "molybdenum.libera.chat",
      body: "is now your hidden host (set by services.)",
      meta: {
        numeric: 396,
        severity: "ok",
        raw_params: ["vjt-claude", "user/vjt-claude", "is now your hidden host (set by services.)"],
      },
    };

    // Azzurra/bahamut, 217 RPL_STATSQLINE — the Q-line mask is a MIDDLE
    // param; the trailing is bahamut's BAD_CONF_CLASS `-1`.
    const statsQLineRow: ScrollbackMessage = {
      id: 301,
      network: "azzurra",
      channel: "$server",
      server_time: 301,
      kind: "notice",
      sender: "irc.azzurra.net",
      body: "-1",
      meta: {
        numeric: 217,
        severity: "ok",
        raw_params: ["mynick", "Q", "spamming", "*", "*.evil.example", "0", "-1"],
      },
    };

    // A generic numeric whose own-nick at raw_params[0] is a distinctive
    // token that must NOT survive to the rendered row.
    const ownNickDropRow: ScrollbackMessage = {
      id: 302,
      network: "libera",
      channel: "$server",
      server_time: 302,
      kind: "notice",
      sender: "irc.example.net",
      body: "trailing-text",
      meta: {
        numeric: 999,
        severity: "ok",
        raw_params: ["ownnick123", "payload-here", "trailing-text"],
      },
    };

    // Pre-#424 backfill / malformed numeric: meta.numeric present but no
    // raw_params. Must still render the trailing body (graceful
    // degradation), never crash or blank the row.
    const backfillNumericRow: ScrollbackMessage = {
      id: 303,
      network: "libera",
      channel: "$server",
      server_time: 303,
      kind: "notice",
      sender: "irc.example.net",
      body: "Highest connection count: 42",
      meta: {
        numeric: 250,
        severity: "ok",
      },
    };

    it("396 RPL_HOSTHIDDEN renders the cloak host (a middle param)", () => {
      setScrollback({ "libera $server": [hostHiddenRow] });
      render(() => <ScrollbackPane networkSlug="libera" channelName="$server" kind="channel" />);
      const line = screen.getByTestId("scrollback-line");
      expect(line.textContent).toContain("user/vjt-claude");
      expect(line.textContent).toContain("is now your hidden host");
    });

    it("217 RPL_STATSQLINE renders the Q-line mask, not just the trailing -1", () => {
      setScrollback({ "azzurra $server": [statsQLineRow] });
      render(() => <ScrollbackPane networkSlug="azzurra" channelName="$server" kind="channel" />);
      const line = screen.getByTestId("scrollback-line");
      expect(line.textContent).toContain("*.evil.example");
      expect(line.textContent).toContain("Q");
    });

    it("drops raw_params[0] (the recipient's own nick) from the rendered row", () => {
      setScrollback({ "libera $server": [ownNickDropRow] });
      render(() => <ScrollbackPane networkSlug="libera" channelName="$server" kind="channel" />);
      const line = screen.getByTestId("scrollback-line");
      expect(line.textContent).not.toContain("ownnick123");
      expect(line.textContent).toContain("payload-here");
      expect(line.textContent).toContain("trailing-text");
    });

    it("numeric with no raw_params (backfill) falls back to the trailing body", () => {
      setScrollback({ "libera $server": [backfillNumericRow] });
      render(() => <ScrollbackPane networkSlug="libera" channelName="$server" kind="channel" />);
      const line = screen.getByTestId("scrollback-line");
      expect(line.textContent).toContain("Highest connection count: 42");
    });

    // #455 per-surface ruling: numerics are a server-generated surface, so
    // the textual-emphasis layer stays OFF (like the ERROR / server_event /
    // generic-numeric arms — server structural text is where snake_case /
    // path / mask junk concentrates). A payload token wrapped in *…* must
    // render as plain text, never a .scrollback-mirc-bold emphasis span.
    const emphasisMarkerNumericRow: ScrollbackMessage = {
      id: 304,
      network: "libera",
      channel: "$server",
      server_time: 304,
      kind: "notice",
      sender: "irc.example.net",
      body: "trailing",
      meta: {
        numeric: 247,
        severity: "ok",
        raw_params: ["mynick", "*spam*", "trailing"],
      },
    };

    it("does NOT apply textual emphasis to numeric payloads (#455 server surface)", () => {
      setScrollback({ "libera $server": [emphasisMarkerNumericRow] });
      render(() => <ScrollbackPane networkSlug="libera" channelName="$server" kind="channel" />);
      const line = screen.getByTestId("scrollback-line");
      // Emphasis OFF: the *spam* token stays plain text, not a bold span.
      expect(line.querySelector(".scrollback-mirc-bold")).toBeNull();
      // The marker chars stay visible regardless (textContent guard).
      expect(line.textContent).toContain("*spam*");
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
  //
  // #887 — the observation is now taken with the tab HIDDEN. Not a
  // convenience: jsdom's zero geometry makes every pane read as "at the
  // tail", so the read-at-the-tail arm fires on its own 500ms debounce and
  // would land a cursor write inside this test's wait window — a write that
  // has nothing to do with the input gate but is indistinguishable from one
  // at the mock. Hiding the tab closes THAT arm (its `isDocumentVisible`
  // gate) through production's own door and leaves the scroll-settle arm
  // fully armed, so what the assertion sees is the gate under test and
  // nothing else. The blur transition itself writes the cursor (the
  // browser-blur arm), hence the explicit clear before the scroll.
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

      // Close the #887 read-at-the-tail arm (visibility gate) and drop the
      // cursor write the blur transition itself performs.
      setDocVisible(false);
      await new Promise((r) => setTimeout(r, 0));
      mockSetCursorIfAdvances.mockClear();

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

  // #887 — read-at-the-tail. The arm that makes an UN-suppressed badge honest.
  //
  // Removing the focused-window suppression (selection.ts) left the badge with
  // no way DOWN while the operator sits at the tail of a quiet window: every
  // pre-existing writer fires when they stop looking (leave / blur / unmount)
  // or when they scroll (settle, gated on a real input event). A message
  // landing while they watch it land would have bumped the badge and left it
  // there — a stuck number instead of a vanishing one, the same complaint
  // wearing a different hat.
  //
  // So: tab visible + pane at the tail ⇒ what is rendered is being read.
  // jsdom's zero geometry reads as at-the-tail via `lastFullyVisibleRowId`'s
  // at-bottom short-circuit, which is exactly the state under test.
  describe("#887 read-at-the-tail cursor advance", () => {
    it("advances to the arriving row with NO operator input event", async () => {
      seedReadCursor("freenode", "#grappa", 1);
      setScrollback({ "freenode #grappa": fixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      await waitFor(() => {
        expect(screen.getAllByTestId("scrollback-line")).toHaveLength(3);
      });

      // No pointerdown / wheel / touchmove / keydown, and no gesture: the
      // scroll-settle arm can never fire here. The only thing that can move
      // the cursor is the state "visible AND at the tail".
      await waitFor(
        () => {
          expect(mockSetCursorIfAdvances).toHaveBeenCalledWith("freenode", "#grappa", 3);
        },
        { timeout: 2_000 },
      );
    });

    it("stands down while the tab is hidden (a backgrounded tab is not being read)", async () => {
      seedReadCursor("freenode", "#grappa", 1);
      setScrollback({ "freenode #grappa": fixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      await waitFor(() => {
        expect(screen.getAllByTestId("scrollback-line")).toHaveLength(3);
      });

      // Hide, and drop the write the blur arm itself performs — what is under
      // test is whether the read-at-the-tail arm keeps firing afterwards.
      setDocVisible(false);
      await new Promise((r) => setTimeout(r, 0));
      mockSetCursorIfAdvances.mockClear();

      // Well past the debounce: a selected-but-backgrounded tab must keep
      // accruing its badge (the one property of the old suppression's
      // visibility gate worth keeping), so nothing may be marked read.
      await new Promise((r) => setTimeout(r, 900));
      expect(mockSetCursorIfAdvances).not.toHaveBeenCalled();
    });
  });

  // #981 — the pane PUBLISHES the same read-at-the-tail answer the cursor arm
  // above acts on, so `selection.ts` can suppress the badge for the window
  // being read without re-deriving (and eventually forking) the predicate.
  //
  // The geometric term is not bindable here — jsdom reports zero-height boxes,
  // so `atBottomNow` reads "at the tail" whatever the test does (measured
  // under #887: deleting that gate left every pane test green). What IS
  // bindable, and what these tests own, is everything around it: the tab
  // visibility term, the mount/unmount lifecycle, and the refusal to answer
  // for a window whose geometry has not been measured yet. The geometry
  // itself is an e2e.
  describe("#981 — the pane publishes which window it is reading at the tail", () => {
    it("publishes its own key while visible with rows rendered", async () => {
      setScrollback({ "freenode #grappa": fixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);

      await waitFor(() => expect(readingAtTailKey()).toBe("freenode #grappa"));
    });

    it("publishes nothing while the tab is hidden (a backgrounded tab is not being read)", async () => {
      setScrollback({ "freenode #grappa": fixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      await waitFor(() => expect(readingAtTailKey()).toBe("freenode #grappa"));

      setDocVisible(false);

      await waitFor(() => expect(readingAtTailKey()).toBeNull());
    });

    it("publishes nothing for an EMPTY window (there is nothing on screen to read)", async () => {
      setScrollback({});
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      await new Promise((r) => setTimeout(r, 50));

      expect(readingAtTailKey()).toBeNull();
    });

    it("clears on unmount — a pane that is gone is reading nothing", async () => {
      setScrollback({ "freenode #grappa": fixture });
      const { unmount } = render(() => (
        <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
      ));
      await waitFor(() => expect(readingAtTailKey()).toBe("freenode #grappa"));

      unmount();

      expect(readingAtTailKey()).toBeNull();
    });

    // The switch re-arms `atBottomNow` TRUE as an INTENT default before any
    // geometry is read (the 2026-06-01 scroll-contamination re-arm in the key
    // effect), and only the activation rAF×2 later replaces it with a real
    // measurement. Publishing across that gap would blink the ARRIVING
    // window's badge to 0 and back — the "vanishes on select" complaint #887
    // was filed about, in miniature. So the answer is withheld until the
    // arriving window's geometry has actually been measured.
    it("withholds the answer across a window switch until geometry is measured", async () => {
      const [chan, setChan] = createSignal("#a");
      setScrollback({ "freenode #a": fixture, "freenode #b": fixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName={chan()} kind="channel" />);
      // jsdom leaves scrollTo undefined; the switch's smooth-scroll interrupt
      // calls it (see the #608 W9 spec, same stub).
      (screen.getByTestId("scrollback") as HTMLDivElement).scrollTo = vi.fn();
      await waitFor(() => expect(readingAtTailKey()).toBe("freenode #a"));

      setChan("#b");

      // Synchronously after the switch: the arriving window is unmeasured.
      expect(readingAtTailKey()).toBeNull();
      // ...and once the activation has settled, it answers for the new window.
      await waitFor(() => expect(readingAtTailKey()).toBe("freenode #b"));
    });
  });

  // #230 — wheel-up loads older history even when the content UNDERFILLS
  // the container. When the loaded window is SHORTER than the viewport,
  // `.scrollback` is not natively scrollable (scrollHeight <= clientHeight),
  // so a mouse wheel produces NO native `scroll` event → `onScroll` never
  // fires → `loadMore` never triggers → the operator is stuck with no way
  // to page up into older scrollback. The fix reacts to the wheel event
  // itself: a wheel-UP (deltaY < 0) while at/near the top fires the SAME
  // `loadMore` the onScroll block uses. jsdom has no layout, so
  // scrollHeight == clientHeight == scrollTop == 0 — the exact underfill
  // geometry we need (not natively scrollable, scrollTop already at the
  // top). RED pre-fix: onWheel only stamped the input marker, loadMore
  // stayed uncalled. GREEN post-fix: the wheel-up path calls loadMore.
  describe("#230 — wheel-up triggers loadMore when content underfills", () => {
    it("wheel-UP on a non-overflowing pane calls loadMore", async () => {
      // A short buffer (few rows) — cic has loaded these but the server
      // may hold older history. In jsdom the pane never natively scrolls.
      const rows: ScrollbackMessage[] = Array.from({ length: 3 }, (_, i) => ({
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

      // Sanity: the pane underfills (jsdom: all geometry is 0), so no
      // native scroll event can ever fire from a wheel. This is the trap.
      expect(list.scrollHeight).toBeLessThanOrEqual(list.clientHeight);

      // Wheel UP over the underfilled pane. onScroll never runs (nothing
      // scrolls); only the wheel path can rescue the operator.
      list.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));

      await waitFor(() => expect(loadMore).toHaveBeenCalledWith("freenode", "#grappa"));
    });

    it("wheel-DOWN on a non-overflowing pane does NOT call loadMore", async () => {
      // Guard the direction gate: only wheel-UP pages older history.
      const rows: ScrollbackMessage[] = Array.from({ length: 3 }, (_, i) => ({
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
      if (!list) throw new Error("scrollback DOM not found");

      list.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true }));

      // Small settle window; loadMore must stay uncalled.
      await new Promise((r) => setTimeout(r, 100));
      expect(loadMore).not.toHaveBeenCalled();
    });

    it("wheel-UP on an OVERFLOWING pane does NOT call loadMore (onScroll owns that path)", async () => {
      // Review fix (#230): the wheel rescue must fire ONLY when the pane is
      // NOT natively scrollable (underfill). On an overflowing pane a
      // wheel-UP produces a native `scroll` event, so `onScroll` already
      // owns loadMore — with the CORRECT post-scroll geometry for the
      // scroll-position restore. If `onWheel` also fired loadMore, it would
      // run one tick EARLIER than the native scroll and capture a STALE
      // pre-scroll `scrollTop`; its post-fetch `.then` would then win the
      // in-flight race and restore to the wrong anchor, landing the viewport
      // ~wheel-delta px lower — partially undoing the operator's scroll. So
      // the wheel path must stay OUT when the pane can natively scroll.
      //
      // jsdom has no layout (all geometry reads 0), so we force the
      // overflowing shape via defineProperty: scrollHeight > clientHeight.
      const rows: ScrollbackMessage[] = Array.from({ length: 3 }, (_, i) => ({
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
      if (!list) throw new Error("scrollback DOM not found");

      // Force the natively-scrollable shape: content taller than the
      // container, operator near (but not at) the top.
      Object.defineProperty(list, "scrollHeight", { value: 5000, configurable: true });
      Object.defineProperty(list, "clientHeight", { value: 500, configurable: true });
      Object.defineProperty(list, "scrollTop", { value: 30, writable: true, configurable: true });

      list.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));

      // Settle window; the wheel path must NOT fire loadMore — the native
      // `scroll` event (dispatched by the browser, not simulated here) is
      // what drives loadMore on an overflowing pane.
      await new Promise((r) => setTimeout(r, 100));
      expect(loadMore).not.toHaveBeenCalled();
    });
  });

  // #285 reopen (P0) — the FAIL-OPEN scroll gate. The first #285 fix (a
  // ResizeObserver) is necessary but NOT sufficient: on a cold iOS-PWA
  // kill+relaunch the boot read latches an INFLATED `--viewport-height`, the
  // container bakes to it, and NO subsequent box change ever fires — so the RO
  // never triggers, `measureOverflow` never re-runs, and the OLD default-deny
  // gate (`.scrollback { touch-action: none }`, only `.scrollback-overflowing`
  // → `pan-y`) leaves the pane PERMANENTLY dead. The reopen fix INVERTS the
  // gate to fail OPEN: base `.scrollback { touch-action: pan-y }`, and only
  // LOCK to `touch-action: none` (via a `.scrollback-locked` class bound to
  // the `scrollLocked` signal) when a TRUSTWORTHY measurement definitively
  // proves the content does not overflow. A false-positive pannable pane is
  // harmless; the P0 is the false-negative dead scroll — so an untrusted
  // (0 / unsettled) clientHeight NEVER locks. `shouldLockScrollGate` is the
  // pure decision seam (below); this describe pins the DOM wiring. CONSTRAINT:
  // the iOS touch-physics unlock itself is on-device-only
  // (feedback_playwright_webkit_not_ios_scroll) — this pins the WIRING.
  describe("#285 reopen — shouldLockScrollGate fail-open decision seam", () => {
    it("does NOT lock when content overflows a trusted viewport (pan-y needed)", () => {
      expect(shouldLockScrollGate({ scrollHeight: 5000, clientHeight: 500 })).toBe(false);
    });

    it("locks when content definitively fits a trusted (nonzero) clientHeight", () => {
      expect(shouldLockScrollGate({ scrollHeight: 100, clientHeight: 500 })).toBe(true);
    });

    it("locks when content exactly fills the viewport (not overflowing)", () => {
      expect(shouldLockScrollGate({ scrollHeight: 500, clientHeight: 500 })).toBe(true);
    });

    it("FAILS OPEN on an untrusted zero clientHeight (the cold-boot latch → never dead)", () => {
      // The reported P0: a pre-settle/unsettled measure reads clientHeight 0.
      // Under the OLD fail-CLOSED gate this latched the pane `touch-action:
      // none` forever. Fail-open MUST leave it pannable (no lock).
      expect(shouldLockScrollGate({ scrollHeight: 0, clientHeight: 0 })).toBe(false);
      expect(shouldLockScrollGate({ scrollHeight: 42, clientHeight: 0 })).toBe(false);
    });

    it("FAILS OPEN on a negative/NaN clientHeight (never trust a bad read)", () => {
      expect(shouldLockScrollGate({ scrollHeight: 10, clientHeight: -1 })).toBe(false);
      expect(shouldLockScrollGate({ scrollHeight: 10, clientHeight: Number.NaN })).toBe(false);
    });
  });

  // The DOM wiring of the fail-open gate: the `.scrollback-locked` class is
  // bound to the `scrollLocked` signal, recomputed by `measureOverflow` on the
  // mount + length + resize + ResizeObserver triggers. jsdom ships no
  // ResizeObserver and no layout, so we stub the observer + drive geometry via
  // defineProperty.
  describe("#285 reopen — fail-open gate DOM wiring", () => {
    const flushRaf = async (): Promise<void> => {
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r(undefined))),
      );
    };

    it("does NOT lock the pane at cold mount (jsdom clientHeight 0 → fail open, never dead)", async () => {
      // jsdom geometry is 0/0 → clientHeight is untrusted → the gate must NOT
      // lock. Under the OLD gate the DEFAULT was `touch-action: none` (dead);
      // the fail-open default carries NO `.scrollback-locked` class so the base
      // `pan-y` applies. This is the direct P0-protection wiring.
      setScrollback({ "freenode #grappa": fixture });
      const { container } = render(() => (
        <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
      ));
      const pane = container.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
      if (!pane) throw new Error("scrollback DOM not found");
      await flushRaf();
      expect(pane.classList.contains("scrollback-locked")).toBe(false);
    });

    it("recomputes the lock gate when the scroll container resizes (ResizeObserver)", async () => {
      let roCallback: ResizeObserverCallback | undefined;
      let observedEl: Element | undefined;
      class FakeResizeObserver {
        constructor(cb: ResizeObserverCallback) {
          roCallback = cb;
        }
        observe(el: Element): void {
          observedEl = el;
        }
        unobserve(): void {}
        disconnect(): void {}
      }
      vi.stubGlobal("ResizeObserver", FakeResizeObserver);
      try {
        setScrollback({ "freenode #grappa": fixture });
        const { container } = render(() => (
          <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
        ));
        const pane = container.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
        if (!pane) throw new Error("scrollback DOM not found");

        // jsdom 0/0 → untrusted → fail open (not locked).
        await flushRaf();
        expect(pane.classList.contains("scrollback-locked")).toBe(false);

        // The observer MUST be wired onto the scroll container (hosts the gate).
        expect(observedEl).toBe(pane);

        // Settle to a TRUSTWORTHY geometry where content FITS (nonzero
        // clientHeight, scrollHeight <= clientHeight) — a box change with NO
        // window/visualViewport `resize` event. The gate must LOCK.
        Object.defineProperty(pane, "scrollHeight", { value: 100, configurable: true });
        Object.defineProperty(pane, "clientHeight", { value: 500, configurable: true });
        roCallback?.([], {} as ResizeObserver);
        await flushRaf();
        expect(pane.classList.contains("scrollback-locked")).toBe(true);

        // Content now overflows the same container → gate UNLOCKS (pan-y). Proves
        // the gate tracks geometry bidirectionally, not a one-shot latch.
        Object.defineProperty(pane, "scrollHeight", { value: 5000, configurable: true });
        Object.defineProperty(pane, "clientHeight", { value: 500, configurable: true });
        roCallback?.([], {} as ResizeObserver);
        await flushRaf();
        expect(pane.classList.contains("scrollback-locked")).toBe(false);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("re-measures the gate on a post-mount settle timer, independent of any event", async () => {
      // #285 reopen part (3): the reported cold-boot settle fires NO resize /
      // box change, so a defensive event-independent re-measure on a short
      // post-mount timer is the belt-and-suspenders corrector. Stub RO to a
      // no-op so the ONLY corrective path is the timer.
      vi.useFakeTimers();
      class NoopResizeObserver {
        constructor(_cb: ResizeObserverCallback) {}
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
      vi.stubGlobal("ResizeObserver", NoopResizeObserver);
      try {
        setScrollback({ "freenode #grappa": fixture });
        const { container } = render(() => (
          <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
        ));
        const pane = container.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
        if (!pane) throw new Error("scrollback DOM not found");

        // Flush the mount + length-effect measures against jsdom's 0/0 geometry
        // → untrusted → fail open (not locked). This settles the initial gate
        // BEFORE the viewport corrects, so the only remaining corrective path is
        // the settle timer (RO is a no-op, no resize is fired).
        await vi.advanceTimersByTimeAsync(50);
        expect(pane.classList.contains("scrollback-locked")).toBe(false);

        // Post-mount the viewport SETTLES: clientHeight is now a trustworthy
        // value against which content fits — but NO resize / RO / box change
        // fires (the reported no-event settle).
        Object.defineProperty(pane, "scrollHeight", { value: 100, configurable: true });
        Object.defineProperty(pane, "clientHeight", { value: 500, configurable: true });

        // Only the event-independent settle timer can correct the gate now.
        await vi.advanceTimersByTimeAsync(2000);
        expect(pane.classList.contains("scrollback-locked")).toBe(true);
      } finally {
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    });

    it("disconnects the ResizeObserver on unmount (no leaked observer)", () => {
      const disconnect = vi.fn();
      class FakeResizeObserver {
        constructor(_cb: ResizeObserverCallback) {}
        observe(): void {}
        unobserve(): void {}
        disconnect = disconnect;
      }
      vi.stubGlobal("ResizeObserver", FakeResizeObserver);
      try {
        setScrollback({ "freenode #grappa": fixture });
        const { unmount } = render(() => (
          <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
        ));
        unmount();
        expect(disconnect).toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  // #778 — a container BOX change moves the fold, so a follower must be re-pinned
  // to the tail. The window/visualViewport `resize` arm already does this, but
  // chrome growing INSIDE the shell (the compose-box send-error line, a wrapping
  // composer) shrinks this box with NO resize event: measured on the #580 e2e, a
  // 25px `.compose-box-error` mounting after the tail write left the pane 32px
  // short of the tail with the just-sent row clipped under it.
  describe("#778 — a container box change re-pins a follower to the tail", () => {
    const flushRaf = async (): Promise<void> => {
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r(undefined))),
      );
    };

    const renderWithFakeRO = async (): Promise<{
      pane: HTMLDivElement;
      fire: () => void;
      scrollIntoViewSpy: ReturnType<typeof vi.fn>;
    }> => {
      let roCallback: ResizeObserverCallback | undefined;
      class FakeResizeObserver {
        constructor(cb: ResizeObserverCallback) {
          roCallback = cb;
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
      vi.stubGlobal("ResizeObserver", FakeResizeObserver);
      const scrollIntoViewSpy = vi.fn();
      // biome-ignore lint/suspicious/noExplicitAny: jsdom Element type compat
      (Element.prototype as any).scrollIntoView = scrollIntoViewSpy;
      setScrollback({ "freenode #grappa": fixture });
      const { container } = render(() => (
        <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
      ));
      const pane = container.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
      if (!pane) throw new Error("scrollback DOM not found");
      // No read cursor → no divider → the cold-mount activation tails and arms
      // followMode from the (jsdom 0/0 ⇒ at-bottom) geometry.
      await flushRaf();
      scrollIntoViewSpy.mockClear();
      return { pane, fire: () => roCallback?.([], {} as ResizeObserver), scrollIntoViewSpy };
    };

    it("re-pins the tail when the container SHRINKS under a follower", async () => {
      try {
        const { pane, fire, scrollIntoViewSpy } = await renderWithFakeRO();
        // The shell chrome grew below the pane: same content, shorter box.
        Object.defineProperty(pane, "scrollHeight", { value: 1650, configurable: true });
        Object.defineProperty(pane, "clientHeight", { value: 187, configurable: true });
        fire();
        await flushRaf();
        expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: "end" });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("does NOT scroll when the box did not change (the observe() baseline callback)", async () => {
      try {
        const { fire, scrollIntoViewSpy } = await renderWithFakeRO();
        // ResizeObserver delivers a callback on observe() with the CURRENT size;
        // a width-only change fires one too. Neither moved the fold, and
        // tail-snapping on them would fight the cold-mount marker activation.
        fire();
        await flushRaf();
        expect(scrollIntoViewSpy).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  // #230 (mobile) — the pure underfill-rescue DECISION seam. Both the desktop
  // wheel path and the mobile touch path funnel through this one function
  // (implement-once); it is the CORE proof because Playwright's webkit project
  // does NOT reproduce real iOS scroll physics, so the mobile bug lives or dies
  // on this decision, not on an e2e. `revealOlderIntent` is the normalized
  // "operator wants older history" signal: wheel deltaY < 0 (desktop) OR a
  // touch finger-drag DOWN the screen (mobile). The `!nativelyScrollable` guard
  // keeps the rescue OUT of the overflowing case, where onScroll owns loadMore
  // with the correct post-scroll geometry.
  describe("#230 — shouldRescueUnderfillLoadOlder decision seam", () => {
    it("underfilled pane + reveal-older intent near the top → true", () => {
      expect(
        shouldRescueUnderfillLoadOlder({
          scrollHeight: 400,
          clientHeight: 800,
          scrollTop: 0,
          revealOlderIntent: true,
          thresholdPx: 200,
        }),
      ).toBe(true);
    });

    it("OVERFLOWING pane + reveal-older intent → false (onScroll owns it)", () => {
      expect(
        shouldRescueUnderfillLoadOlder({
          scrollHeight: 5000,
          clientHeight: 500,
          scrollTop: 0,
          revealOlderIntent: true,
          thresholdPx: 200,
        }),
      ).toBe(false);
    });

    it("underfilled pane but scrollTop past the top threshold → false", () => {
      expect(
        shouldRescueUnderfillLoadOlder({
          scrollHeight: 400,
          clientHeight: 800,
          scrollTop: 250,
          revealOlderIntent: true,
          thresholdPx: 200,
        }),
      ).toBe(false);
    });

    it("underfilled pane + NO reveal-older intent (wrong drag direction) → false", () => {
      expect(
        shouldRescueUnderfillLoadOlder({
          scrollHeight: 400,
          clientHeight: 800,
          scrollTop: 0,
          revealOlderIntent: false,
          thresholdPx: 200,
        }),
      ).toBe(false);
    });
  });

  // #230 (mobile) — the touch path wiring. On iOS an underfilled `.scrollback`
  // (touch-action: none, non-overflowing) emits NO native `scroll` on a touch
  // drag, so `onScroll` never fires and the desktop wheel rescue has no touch
  // counterpart. A finger drag DOWN the screen (clientY increases → dy > 0)
  // reveals content ABOVE = older history — the touch analogue of wheel
  // deltaY < 0 — and must funnel into the SAME `maybeLoadOlder` the wheel path
  // uses. jsdom has no real TouchEvent/Touch, so these dispatch a synthetic
  // touch* Event with a hand-attached `touches` list to exercise the
  // element-level {passive:false} listener bound in onMount. This proves the
  // WIRING (gesture → decision → loadMore); the on-device iOS physics can only
  // be confirmed by a real-device dogfood (see the spec header).
  describe("#230 — touch-drag-down triggers loadMore when content underfills", () => {
    const shortRows = (): ScrollbackMessage[] =>
      Array.from({ length: 3 }, (_, i) => ({
        id: i + 1,
        network: "freenode",
        channel: "#grappa",
        server_time: i + 1,
        kind: "privmsg",
        sender: "alice",
        body: `row ${i + 1}`,
        meta: {},
      }));

    const fireTouch = (el: HTMLElement, type: string, ...clientYs: number[]): void => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "touches", {
        value: clientYs.map((clientY) => ({ clientY })),
        configurable: true,
      });
      el.dispatchEvent(ev);
    };

    it("finger drag DOWN on an underfilled pane calls loadMore", async () => {
      setScrollback({ "freenode #grappa": shortRows() });
      const { container } = render(() => (
        <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
      ));
      const list = container.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
      if (!list) throw new Error("scrollback DOM not found");

      // Underfill precondition (jsdom: all geometry is 0 → not natively
      // scrollable, scrollTop already at the top).
      expect(list.scrollHeight).toBeLessThanOrEqual(list.clientHeight);

      // Finger starts high, drags DOWN the screen (clientY 100 → 260): dy > 0
      // = reveal older. Only the touch path can rescue an underfilled pane.
      fireTouch(list, "touchstart", 100);
      fireTouch(list, "touchmove", 260);

      await waitFor(() => expect(loadMore).toHaveBeenCalledWith("freenode", "#grappa"));
    });

    it("finger drag UP on an underfilled pane does NOT call loadMore", async () => {
      setScrollback({ "freenode #grappa": shortRows() });
      const { container } = render(() => (
        <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
      ));
      const list = container.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
      if (!list) throw new Error("scrollback DOM not found");

      // Finger drags UP (clientY 260 → 100): dy < 0 = reveal newer, not older.
      fireTouch(list, "touchstart", 260);
      fireTouch(list, "touchmove", 100);

      await new Promise((r) => setTimeout(r, 100));
      expect(loadMore).not.toHaveBeenCalled();
    });

    it("finger drag DOWN on an OVERFLOWING pane does NOT call loadMore (onScroll owns it)", async () => {
      setScrollback({ "freenode #grappa": shortRows() });
      const { container } = render(() => (
        <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
      ));
      const list = container.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
      if (!list) throw new Error("scrollback DOM not found");

      // Force the natively-scrollable shape (content taller than the container).
      // A touch drag then produces a native `scroll`, so onScroll owns loadMore
      // with the correct post-scroll geometry — the touch rescue must stay out.
      Object.defineProperty(list, "scrollHeight", { value: 5000, configurable: true });
      Object.defineProperty(list, "clientHeight", { value: 500, configurable: true });
      Object.defineProperty(list, "scrollTop", { value: 30, writable: true, configurable: true });

      fireTouch(list, "touchstart", 100);
      fireTouch(list, "touchmove", 260);

      await new Promise((r) => setTimeout(r, 100));
      expect(loadMore).not.toHaveBeenCalled();
    });

    it("two-finger (pinch) touchmove on an underfilled pane does NOT call loadMore", async () => {
      // The rescue is a SINGLE-finger page-up gesture; a two-finger pinch is not
      // a load-older intent even if the first finger drifts downward.
      setScrollback({ "freenode #grappa": shortRows() });
      const { container } = render(() => (
        <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
      ));
      const list = container.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
      if (!list) throw new Error("scrollback DOM not found");

      // Two active touches, both moving DOWN — a pinch/multi-touch, not a drag.
      fireTouch(list, "touchstart", 100, 300);
      fireTouch(list, "touchmove", 260, 460);

      await new Promise((r) => setTimeout(r, 100));
      expect(loadMore).not.toHaveBeenCalled();
    });
  });

  // freeze the pane's scroll for its whole lifetime. #219 gated the freeze
  // on the media-viewer snapshot only; the generalization keys it on the
  // shared overlay refcount (`overlayScrollLock.overlayCount()`), which
  // every covering modal/drawer already pushes into (the media viewer is
  // just one participant). A resize while an overlay is open — the exact
  // authority a mobile fullscreen modal fires via visualViewport — must
  // NOT snap the pane to the tail.
  //
  // jsdom has no layout, so we assert via the tail `scrollIntoView` the
  // resize→scrollToActivation("tail-only") path calls when NOT frozen.
  // Pre-fix (media-only gate) a plain overlay push does not freeze → the
  // tail scrollIntoView fires. Post-fix it is suppressed while the
  // refcount is non-zero, and resumes once the overlay closes.
  describe("#219-general — covering overlay freezes the pane (any overlay, not just media)", () => {
    let scrollIntoViewSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      resetOverlayLock();
      scrollIntoViewSpy = vi.fn();
      // biome-ignore lint/suspicious/noExplicitAny: jsdom Element type compat
      (Element.prototype as any).scrollIntoView = scrollIntoViewSpy;
    });

    afterEach(() => {
      resetOverlayLock();
    });

    const seedRows = (): void => {
      setScrollback({
        "freenode #grappa": Array.from({ length: 20 }, (_, i) => ({
          id: i + 1,
          network: "freenode",
          channel: "#grappa",
          server_time: i + 1,
          kind: "privmsg" as const,
          sender: "alice",
          body: `row ${i + 1}`,
          meta: {},
        })),
      });
    };

    // rAF drain — scrollToActivation schedules the tail scrollIntoView
    // inside a double-rAF (geometry-after-layout idiom).
    const flushRaf = async (): Promise<void> => {
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r(undefined))),
      );
    };

    it("a resize with NO overlay open snaps to the tail (baseline — the authority fires)", async () => {
      seedRows();
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      await flushRaf();
      scrollIntoViewSpy.mockClear();

      window.dispatchEvent(new Event("resize"));
      await flushRaf();

      // No overlay → not frozen → the tail-snap authority scrolls.
      expect(scrollIntoViewSpy).toHaveBeenCalled();
    });

    it("a resize WHILE a covering overlay is open does NOT snap to the tail (frozen)", async () => {
      seedRows();
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      await flushRaf();

      // Open a covering overlay via the shared refcount (any modal does
      // this — Confirm/Names/Who/Archive/DeleteAccount/TopicBar). No media
      // viewer involved: this is the case #219's media-only gate missed.
      pushOverlay(null);
      await flushRaf();
      scrollIntoViewSpy.mockClear();

      window.dispatchEvent(new Event("resize"));
      await flushRaf();

      // Covered pane is frozen → the tail-snap authority is gated out.
      expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    });

    it("after the overlay closes, the pane resumes normal activation (thaw)", async () => {
      seedRows();
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      await flushRaf();

      pushOverlay(null);
      await flushRaf();
      popOverlay(null);
      await flushRaf();
      scrollIntoViewSpy.mockClear();

      window.dispatchEvent(new Event("resize"));
      await flushRaf();

      // Overlay gone → freeze lifted → the authority scrolls again.
      expect(scrollIntoViewSpy).toHaveBeenCalled();
    });

    // #608 step 2 — the freeze is DERIVED from the live overlay refcount, not a
    // separately-cleared latch. The thaw must follow the count→0 edge the same
    // tick it happens, independent of whether the deferred snapshot-clear rAF
    // has run. Pre-fix (`isOverlayFrozen` = `overlayScrollSnapshot !== null`)
    // the pane stayed frozen until the clear rAF fired — and a leaked / never-
    // firing clear stranded it FOREVER (the field bug root). Post-fix
    // `isOverlayFrozen` = `overlayCount() > 0`, so a resize snaps to the tail
    // the instant the last overlay closes, with no reliance on the clear.
    it("thaws the instant count→0, without awaiting the deferred snapshot clear (live-derived freeze)", async () => {
      seedRows();
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      await flushRaf();

      pushOverlay(null);
      await flushRaf();

      // Close the last overlay, then IMMEDIATELY resize — NO flushRaf between,
      // so the deferred snapshot-clear rAF has NOT run. The live-derived freeze
      // must already read false because `overlayCount() === 0`.
      popOverlay(null);
      scrollIntoViewSpy.mockClear();

      window.dispatchEvent(new Event("resize"));
      await flushRaf();

      expect(scrollIntoViewSpy).toHaveBeenCalled();
    });

    // #608 step 3 (characterization for the applier funnel) — a message
    // arriving WHILE a covering overlay is up must NOT tail-follow the covered
    // pane: the length-effect re-asserts the held snapshot (a `scrollTop`
    // write), it never tails (`scrollIntoView`). This pins the
    // overlay-freeze ▸ tail-follow precedence AT the length-effect — the exact
    // branch order about to be routed through the pure `resolveIntent` core. The
    // e2e twin is issue196-preview-scroll-live-arrival; this is the
    // jsdom-observable half (the scrollIntoView spy).
    it("a message arriving while an overlay is up does NOT tail-follow the covered pane (frozen)", async () => {
      seedRows();
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      await flushRaf();

      pushOverlay(null);
      await flushRaf();
      scrollIntoViewSpy.mockClear();

      // A new message lands (rows length 20 → 21) → the length-effect runs.
      setScrollback({
        "freenode #grappa": Array.from({ length: 21 }, (_, i) => ({
          id: i + 1,
          network: "freenode",
          channel: "#grappa",
          server_time: i + 1,
          kind: "privmsg" as const,
          sender: "alice",
          body: `row ${i + 1}`,
          meta: {},
        })),
      });
      await flushRaf();

      // Frozen → the length-effect re-asserts the snapshot; it does not tail.
      expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    });

    // #608 step 3 (characterization for the applier funnel) — the W1 overlay
    // RESTORE write. When a covering overlay opens the pane's scrollTop is
    // captured; if the ref-keyed <For> then resets it to 0 under the overlay (a
    // message arriving beneath a modal), the overlay effect re-asserts the
    // captured px across rAF×2. This pins that restore write observably BEFORE
    // the applier extracts it into its own `applyOverlayRestore` entrypoint (W1
    // restores on BOTH refcount edges, so it can't reuse the commit-frame
    // overlay-freeze dispatch which requires `isOverlayFrozen()`). scrollIntoView
    // is spied no-op by the block's beforeEach, so the mount tail-follow can't
    // overwrite the restore.
    it("re-asserts the captured scrollTop across the overlay edge (the W1 restore)", async () => {
      seedRows();
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const list = screen.getByTestId("scrollback") as HTMLDivElement;
      await flushRaf();

      // Reader parked at 250px.
      Object.defineProperty(list, "scrollTop", { value: 250, writable: true, configurable: true });

      // Overlay opens → the effect captures scrollTop (250) on the open edge.
      pushOverlay(null);
      // The ref-keyed <For> resets scrollTop to 0 under the overlay.
      list.scrollTop = 0;
      await flushRaf();

      // The overlay restore re-asserts the captured 250 (same key).
      expect(list.scrollTop).toBe(250);
    });

    // Regression (review PLAUSIBLE): a rapid close→reopen of a covering
    // overlay (refcount 1→0→1) — one modal closing as another opens in the
    // same tick, e.g. /names dismissed by a nick-click that opens a query
    // that itself surfaces a modal — must NOT leave the pane thawed while an
    // overlay is still up. The close transition's snapshot-clear must not
    // null the snapshot the reopen transition just re-armed. After the
    // dust settles with the refcount back at 1, a resize must still be frozen.
    it("a rapid close→reopen (refcount 1→0→1) keeps the pane frozen (snapshot not stale-cleared)", async () => {
      seedRows();
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      await flushRaf();

      // First overlay up.
      pushOverlay(null);
      await flushRaf();

      // Close then immediately reopen — the two transitions' effects + rAFs
      // interleave. Refcount ends at 1 (an overlay IS open).
      popOverlay(null);
      pushOverlay(null);
      await flushRaf();
      await flushRaf();
      scrollIntoViewSpy.mockClear();

      // An overlay is still open → the pane must be frozen.
      window.dispatchEvent(new Event("resize"));
      await flushRaf();

      expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    });

    // #608 (regression, media-viewer close snap) — the freeze holds the reader's
    // position for the overlay's whole lifetime, but the follow INTENT could be
    // left stale. When the reader is scrolled up (snapshot mid-list) but
    // `followMode` is still true — the scroll-up onScroll edge dropped by the
    // freeze bail (a scroll racing the freeze engaging) — the close edge restores
    // the mid position AND a lingering `tailFollowWhenSettled` poll (which gates
    // only on `followMode`/`isConnected`, not the freeze) fail-safe-tailed the
    // pane the instant the overlay closed: the reader was yanked to the bottom on
    // close (the #219 media-viewer report, e2e issue219-overlay-scroll-hold). The
    // fix reconciles `followMode` with the RESTORED geometry on the overlay edges
    // (the snapshot is the reader's trusted position): mid-list snapshot ⇒
    // `followMode=false`, so a later content-change never tails. Derived from
    // geometry — no separately-cleared latch. The e2e twin drives the real resize
    // authority; this is the jsdom-observable half (the scrollIntoView spy).
    it("reconciles followMode to a mid-list snapshot on overlay close (a later resize does NOT snap)", async () => {
      seedRows();
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const list = screen.getByTestId("scrollback") as HTMLDivElement;
      await flushRaf();

      // A tall, genuinely-scrollable pane with the reader parked mid-list. No
      // scroll event is dispatched, so `followMode` stays at its stale mount value
      // (true) — the exact stuck-follow state the freeze/onScroll race produces
      // (the scroll-up onScroll edge dropped by the freeze bail). This is the
      // inverse of the thaw case above (whose snapshot sits at the tail → the
      // resize legitimately re-pins): here the reader is mid-list, so the follow
      // intent must be reconciled OFF and the resize must be a no-op.
      Object.defineProperty(list, "scrollHeight", { value: 2000, configurable: true });
      Object.defineProperty(list, "clientHeight", { value: 500, configurable: true });
      Object.defineProperty(list, "scrollTop", { value: 750, writable: true, configurable: true });

      // Overlay opens at the mid position (snapshot=750) then closes.
      pushOverlay(null);
      await flushRaf();
      popOverlay(null);
      await flushRaf();
      scrollIntoViewSpy.mockClear();

      // A resize fires after the close (the e2e's real authority). Reader was
      // mid-list → followMode reconciled false → onResize's follow gate is off →
      // no tail snap. Pre-fix followMode was stale-true → the resize snapped.
      window.dispatchEvent(new Event("resize"));
      await flushRaf();

      expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    });
  });

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
      source: "user",
      user: "carol_u",
      host: "carol.host",
      realname: "Carol",
      server: "irc.overlaynet",
      server_info: "Overlay Hub",
      is_operator: false,
      oper_text: null,
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
      account: null,
      secure: false,
      secure_cipher: null,
      certfp: null,
      extra_lines: null,
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

  // #222 — presence-filter WIRING through rows(). The pure precedence math
  // (49 shown / 50 hidden + the truth table) is proven in
  // presenceFilter.test.ts; THIS block proves ScrollbackPane's rows() memo
  // actually feeds the LIVE membersByChannel() count into the filter (the
  // review-flagged hole: a hard-coded `channelPresenceVisible(key(), 0)`
  // would pass every pure test yet silently break auto-hide). The e2e can't
  // cover this — 50 real peers from one IP risks bahamut autokill — so the
  // component test seeding members past the threshold is the authoritative
  // size-default-wiring witness.
  describe("#222 presence filter — rows() size-default wiring", () => {
    // one privmsg + one join for #pf on network n. The join is the
    // suppressible row; the privmsg is the survivor.
    const pfFixture: ScrollbackMessage[] = [
      {
        id: 1,
        network: "n",
        channel: "#pf",
        server_time: 1,
        kind: "privmsg",
        sender: "alice",
        body: "real content",
        meta: {},
      },
      {
        id: 2,
        network: "n",
        channel: "#pf",
        server_time: 2,
        kind: "join",
        sender: "bob",
        body: null,
        meta: {},
      },
    ];
    const pfKey = "n #pf" as ChannelKey; // matches the mocked channelKey shape
    const membersOfSize = (size: number): Record<string, { nick: string; modes: string[] }[]> => ({
      [pfKey]: Array.from({ length: size }, (_, i) => ({ nick: `m${i}`, modes: [] })),
    });

    beforeEach(() => {
      clearChannelPresencePref(pfKey);
      setScrollback({ [pfKey]: pfFixture });
    });

    afterEach(() => {
      clearChannelPresencePref(pfKey);
    });

    it("SMALL channel (below threshold), unset pref → join row rendered", () => {
      mockMembersByChannel.mockReturnValue(membersOfSize(LARGE_CHANNEL_THRESHOLD - 1));
      render(() => <ScrollbackPane networkSlug="n" channelName="#pf" kind="channel" />);
      expect(screen.getByText("real content")).toBeInTheDocument();
      expect(document.querySelector('[data-kind="join"]')).not.toBeNull();
    });

    it("LARGE channel (at threshold), unset pref → join row auto-hidden, privmsg stays", () => {
      // Proves rows() reads the LIVE count: only the member count differs
      // from the passing case above, and only the join row disappears.
      mockMembersByChannel.mockReturnValue(membersOfSize(LARGE_CHANNEL_THRESHOLD));
      render(() => <ScrollbackPane networkSlug="n" channelName="#pf" kind="channel" />);
      expect(screen.getByText("real content")).toBeInTheDocument();
      expect(document.querySelector('[data-kind="join"]')).toBeNull();
    });

    it("explicit 'show' pref pins the join row visible even on a LARGE channel", () => {
      mockMembersByChannel.mockReturnValue(membersOfSize(LARGE_CHANNEL_THRESHOLD * 10));
      setChannelPresencePref(pfKey, "show");
      render(() => <ScrollbackPane networkSlug="n" channelName="#pf" kind="channel" />);
      expect(document.querySelector('[data-kind="join"]')).not.toBeNull();
    });

    it("explicit 'hide' pref hides the join row even on a SMALL channel", () => {
      mockMembersByChannel.mockReturnValue(membersOfSize(2));
      setChannelPresencePref(pfKey, "hide");
      render(() => <ScrollbackPane networkSlug="n" channelName="#pf" kind="channel" />);
      expect(screen.getByText("real content")).toBeInTheDocument();
      expect(document.querySelector('[data-kind="join"]')).toBeNull();
    });
  });

  // #325 — the presence toggle (🙈, #222) must suppress join/part/quit churn
  // ONLY; it must NOT take the #237 on-JOIN topic line down with it. The bug:
  // the topic-join anchor scanned the FILTERED rows for the operator's own-JOIN
  // row, so when presence-hide dropped that JOIN the anchor vanished and the
  // topic line was never spliced in. The fix anchors to the newest own-JOIN in
  // the UNFILTERED buffer and splices after the last surviving row at-or-before
  // that timeline point (falling back to the buffer head).
  describe("#325 topic-join line survives the presence-hide filter", () => {
    const k325 = "freenode #t325" as ChannelKey; // channelKey mock shape: `${slug} ${name}`
    const topicText = "topic set before vjt joined — #325 witness";
    const seededTopic = () => seedTopic(k325, { text: topicText, set_by: "alice", set_at: null });

    beforeEach(() => {
      setUserNick("vjt");
      clearChannelPresencePref(k325);
      mockMembersByChannel.mockReturnValue({});
      seededTopic();
    });

    afterEach(() => {
      clearChannelPresencePref(k325);
      setUserNick(null);
      // Reset the module-singleton topic store so the seed can't leak into
      // sibling suites (a null-text entry renders no topic-join line).
      seedTopic(k325, { text: null, set_by: null, set_at: null });
    });

    // Regression guard: presence SHOWN (unset pref, small channel) — the line
    // still lands immediately AFTER the operator's own-JOIN row, unchanged.
    it("presence shown: topic-join line renders right after the own-JOIN row", () => {
      setScrollback({
        [k325]: [
          {
            id: 100,
            network: "freenode",
            channel: "#t325",
            server_time: 100,
            kind: "privmsg",
            sender: "alice",
            body: "hello",
            meta: {},
          },
          {
            id: 101,
            network: "freenode",
            channel: "#t325",
            server_time: 101,
            kind: "join",
            sender: "vjt",
            body: null,
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#t325" kind="channel" />);
      const ownJoin = document.querySelector('[data-kind="join"]');
      const topicJoin = screen.getByTestId("topic-join-line");
      expect(ownJoin).not.toBeNull();
      expect(topicJoin).toHaveTextContent(topicText);
      // topic-join follows the own-JOIN row in DOM order.
      expect(
        (ownJoin as Node).compareDocumentPosition(topicJoin) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    // THE #325 BUG: presence HIDDEN — the own-JOIN row is filtered out, but the
    // topic line MUST still render (pre-fix it vanished as collateral).
    it("presence hidden: own-JOIN suppressed yet the topic-join line still shows", () => {
      setChannelPresencePref(k325, "hide");
      setScrollback({
        [k325]: [
          {
            id: 100,
            network: "freenode",
            channel: "#t325",
            server_time: 100,
            kind: "privmsg",
            sender: "alice",
            body: "hello",
            meta: {},
          },
          {
            id: 101,
            network: "freenode",
            channel: "#t325",
            server_time: 101,
            kind: "join",
            sender: "vjt",
            body: null,
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#t325" kind="channel" />);
      // #222 filter drops the own-JOIN churn row...
      expect(document.querySelector('[data-kind="join"]')).toBeNull();
      // ...but the #237 topic line survives (the whole point of #325).
      expect(screen.getByTestId("topic-join-line")).toHaveTextContent(topicText);
    });

    // Anchor sanity under hide: own-JOIN sandwiched between two visible rows.
    // The line lands between them — after the last surviving row at-or-before
    // the (hidden) JOIN, before the row that came after it.
    it("presence hidden: topic-join line anchors at the JOIN's timeline slot", () => {
      setChannelPresencePref(k325, "hide");
      setScrollback({
        [k325]: [
          {
            id: 200,
            network: "freenode",
            channel: "#t325",
            server_time: 200,
            kind: "privmsg",
            sender: "alice",
            body: "before join",
            meta: {},
          },
          {
            id: 201,
            network: "freenode",
            channel: "#t325",
            server_time: 201,
            kind: "join",
            sender: "vjt",
            body: null,
            meta: {},
          },
          {
            id: 202,
            network: "freenode",
            channel: "#t325",
            server_time: 202,
            kind: "privmsg",
            sender: "carol",
            body: "after join",
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#t325" kind="channel" />);
      const before = screen.getByText("before join");
      const after = screen.getByText("after join");
      const topicJoin = screen.getByTestId("topic-join-line");
      // before → topic-join → after
      expect(
        before.compareDocumentPosition(topicJoin) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        topicJoin.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    // part/rejoin cycle with presence hidden: two own-JOINs in the buffer, both
    // filtered out. Still EXACTLY ONE topic-join line, anchored to the newest.
    it("presence hidden: exactly one topic-join line after a part/rejoin cycle", () => {
      setChannelPresencePref(k325, "hide");
      setScrollback({
        [k325]: [
          {
            id: 300,
            network: "freenode",
            channel: "#t325",
            server_time: 300,
            kind: "join",
            sender: "vjt",
            body: null,
            meta: {},
          },
          {
            id: 301,
            network: "freenode",
            channel: "#t325",
            server_time: 301,
            kind: "privmsg",
            sender: "alice",
            body: "mid",
            meta: {},
          },
          {
            id: 302,
            network: "freenode",
            channel: "#t325",
            server_time: 302,
            kind: "join",
            sender: "vjt",
            body: null,
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#t325" kind="channel" />);
      expect(screen.getAllByTestId("topic-join-line")).toHaveLength(1);
    });
  });
});
