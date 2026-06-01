import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// UX-4 bucket N (2026-05-19) — selection mock must use a REAL Solid
// signal so Shell's reactive `<Show when={sel.kind === "admin" && isAdmin()}>`
// re-runs when tests flip selection via `setSelectedChannel`. The
// pre-bucket plain-object getter pattern stored the new value but
// never notified consumers — fine for tests that only assert
// `setSelectedChannel was called`, but bucket N's pane-mount test
// chains "click → setSelectedChannel(admin) → Show flips → AdminPane
// mounts in DOM" and needs end-to-end reactivity. A real signal
// trivially also satisfies the `.toHaveBeenCalledWith` style tests
// since `setSelectedChannelMock` still wraps the setter.
const selectionState = vi.hoisted(() => {
  // Lazy-init the signal inside the first accessor call — `vi.hoisted`
  // runs before vitest's solid-js plugin has fully primed Solid's
  // dispose-owner stack, so creating the signal at hoist-time would
  // log "createSignal called without owner". Tests reset the signal
  // in beforeEach via `setSelSig(null)`.
  let sig:
    | [
        () => { networkSlug: string; channelName: string; kind: string } | null,
        (
          v: { networkSlug: string; channelName: string; kind: string } | null,
        ) => { networkSlug: string; channelName: string; kind: string } | null,
      ]
    | null = null;
  const ensure = () => {
    if (sig === null) {
      sig = createSignal<{ networkSlug: string; channelName: string; kind: string } | null>(null);
    }
    return sig;
  };
  return {
    selSig: () => ensure()[0](),
    setSelSig: (v: { networkSlug: string; channelName: string; kind: string } | null) => {
      ensure()[1](v);
    },
    setSelectedChannelMock: vi.fn(
      (v: { networkSlug: string; channelName: string; kind: string } | null) => {
        ensure()[1](v);
      },
    ),
  };
});

// Mutable isMobile ref so individual tests can flip to mobile mode.
const mobileState = vi.hoisted(() => ({ value: false }));
// UX-4 bucket M (2026-05-19) — bearer state for the post-login bootstrap
// effect that loads the upload-TTL preference. Default null = no token
// yet; tests that exercise the bootstrap set it before mount.
const tokenHolder = vi.hoisted(() => ({ value: null as string | null }));

// M-cluster M-7 — mutable me holder. Default is a non-admin user so
// the existing pre-M-7 tests pass unchanged (no admin entry rendered,
// no admin pane mounted). M-7 tests below flip is_admin to true.
//
// UX-4 bucket N (2026-05-19) — like selectionState, this is now a real
// Solid signal so the demote-mid-session test can flip is_admin and
// observe Shell's reactive demote effect redirect selection.
const userHolder = vi.hoisted(() => {
  type Me =
    | { kind: "user"; id: string; name: string; is_admin: boolean; inserted_at: string }
    | { kind: "visitor"; id: string; nick: string; network_slug: string; expires_at: string }
    | null;
  let sig: [() => Me, (v: Me) => Me] | null = null;
  const ensure = () => {
    if (sig === null) {
      sig = createSignal<Me>({
        kind: "user",
        id: "u1",
        name: "vjt",
        is_admin: false,
        inserted_at: "x",
      });
    }
    return sig;
  };
  return {
    get current() {
      return ensure()[0]();
    },
    set current(v: Me) {
      ensure()[1](v);
    },
  };
});

vi.mock("@solidjs/router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("../lib/networks", () => ({
  networks: () => [{ id: 1, slug: "freenode", nick: "vjt", inserted_at: "", updated_at: "" }],
  channelsBySlug: () => ({
    freenode: [
      { name: "#a", joined: true, source: "autojoin" },
      { name: "#b", joined: true, source: "autojoin" },
    ],
  }),
  user: () => userHolder.current,
  // UX-4 bucket N — Shell.tsx imports `isAdmin` from networks.ts as
  // single source of truth (hoisted from Shell + SettingsDrawer +
  // Sidebar). Mirror the live impl so tests that flip is_admin on the
  // userHolder propagate through the predicate.
  isAdmin: () => {
    const u = userHolder.current;
    return u?.kind === "user" && u.is_admin === true;
  },
  networkBySlug: () => undefined,
}));

vi.mock("../lib/selection", () => ({
  selectedChannel: () => selectionState.selSig(),
  setSelectedChannel: selectionState.setSelectedChannelMock,
  unreadCounts: () => ({}),
  messagesUnread: () => ({}),
  eventsUnread: () => ({}),
  applySeedEnvelope: vi.fn(),
}));

vi.mock("../lib/scrollback", () => ({
  scrollbackByChannel: () => ({}),
  appendToScrollback: vi.fn(),
  loadInitialScrollback: vi.fn(),
  loadMore: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("../lib/members", () => ({
  membersByChannel: () => ({}),
  applyPresenceEvent: vi.fn(),
  seedFromTest: vi.fn(),
  // UX-4 bucket J: MembersPane imports `sortMembers`; the mock must
  // expose it so Shell render tests (which mount MembersPane) don't
  // throw "No 'sortMembers' export". Identity sort is fine here — none
  // of the Shell tests assert member order.
  sortMembers: <T,>(list: T[]) => list,
}));

vi.mock("../lib/channelTopic", () => ({
  topicByChannel: () => ({}),
  modesByChannel: () => ({}),
  compactModeString: (modes: string[]) => (modes.length > 0 ? `+${modes.join("")}` : ""),
  seedTopic: vi.fn(),
  seedModes: vi.fn(),
}));

vi.mock("../lib/mentions", () => ({
  mentionCounts: () => ({}),
  bumpMention: vi.fn(),
  clearMentionsForKey: vi.fn(),
}));

vi.mock("../lib/compose", () => ({
  getDraft: () => "",
  setDraft: vi.fn(),
  submit: vi.fn(),
  recallPrev: vi.fn(),
  recallNext: vi.fn(),
  tabComplete: vi.fn(),
}));

vi.mock("../lib/theme", () => ({
  getTheme: vi.fn(() => "auto"),
  setTheme: vi.fn(),
  isMobile: () => mobileState.value,
}));

vi.mock("../lib/auth", () => ({
  logout: vi.fn().mockResolvedValue(undefined),
  token: () => tokenHolder.value,
  // Visitor session-sharing — SettingsDrawer reads `getSubject()` to
  // gate the share-session entry visibility (visitor-only). Shell.test
  // doesn't care about the entry, but if the mock doesn't expose
  // `getSubject` the drawer crashes the moment Shell renders it.
  getSubject: () => null,
}));

// UX-4 bucket M (2026-05-19) — Shell.tsx's bootstrap effect calls
// loadUploadTtlSeconds when both token + /me have resolved. Mock so
// the test doesn't hit the network; specific tests assert against the
// mock to verify the bootstrap fired exactly once. Use importOriginal
// so PrivacyModal (transitively imported by Shell) still finds its
// `privacyModalState` etc. exports.
vi.mock("../lib/imageUploadOrchestrator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/imageUploadOrchestrator")>();
  return {
    ...actual,
    loadUploadTtlSeconds: vi.fn(async () => {}),
  };
});

vi.mock("../lib/queryWindows", () => ({
  queryWindowsByNetwork: () => ({}),
  closeQueryWindowState: vi.fn(),
  openQueryWindowState: vi.fn(),
  setQueryWindowsByNetwork: vi.fn(),
}));

vi.mock("../lib/mentionsWindow", () => ({
  mentionsBundleBySlug: () => ({
    freenode: {
      network_slug: "freenode",
      away_started_at: "2026-05-05T10:00:00.000Z",
      away_ended_at: "2026-05-05T10:30:00.000Z",
      away_reason: "lunch",
      messages: [
        {
          server_time: 1_746_442_200_000,
          channel: "#grappa",
          sender: "alice",
          body: "hey vjt",
          kind: "privmsg",
        },
      ],
    },
  }),
}));

vi.mock("../lib/readCursor", () => ({
  // CP29 R-4: Shell.tsx no longer imports readCursor (the mention-click
  // cursor-rewind hack was dropped — the new id-based server cursor model
  // can't express "rewind to just before an arbitrary timestamp"; the
  // MentionsBundle wire shape doesn't even carry message ids). Module
  // mock kept as a no-op so any transitive import (e.g. via networks.ts
  // hydrating /me) doesn't trigger the real localStorage purge inside
  // jsdom.
  getReadCursor: vi.fn(() => null),
  applyMeEnvelope: vi.fn(),
  applyJoinReply: vi.fn(),
  applyReadCursorSet: vi.fn(),
  setReadCursor: vi.fn().mockResolvedValue(undefined),
  clearReadCursors: vi.fn(),
}));

// M-cluster M-8 — AdminPane now transitively imports AdminVisitorsTab
// which fires `adminListVisitors` onMount. Mock the inner tab so the
// Shell-level admin-pane lifecycle tests (M-7) don't need to know
// about admin REST surfaces. AdminVisitorsTab has its own dedicated
// vitest + Playwright suite.
vi.mock("../AdminVisitorsTab", () => ({
  default: () => <div data-testid="admin-visitors-tab-mock">visitors-tab</div>,
}));

vi.mock("../lib/api", () => ({
  postPart: vi.fn().mockResolvedValue(undefined),
  displayNick: (me: { kind: "user" | "visitor"; name?: string; nick?: string }) =>
    me.kind === "user" ? (me.name ?? "") : (me.nick ?? ""),
  // Per-network IRC nick — see subscribe.test.ts moduledoc + cic H3.
  ownNickForNetwork: (
    net: { slug: string; nick?: string },
    me: { kind: "user" | "visitor"; nick?: string; network_slug?: string } | null | undefined,
  ) => {
    if (me == null) return null;
    if (me.kind === "visitor") return me.network_slug === net.slug ? (me.nick ?? null) : null;
    return net.nick && net.nick !== "" ? net.nick : null;
  },
  // 2026-06-01 (unread-badges-from-cursor cluster, bucket B2):
  // selection.ts now imports isContentKind from api.ts for the badge
  // memo derivation. Any test importing selection (directly or
  // transitively) needs the classifier in its api mock.
  isContentKind: (k: string) => k === "privmsg" || k === "notice" || k === "action",
  isPresenceKind: (k: string) => !(k === "privmsg" || k === "notice" || k === "action"),
}));

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
  decodeChannelKey: (key: string) => {
    const sep = key.indexOf(" ");
    if (sep < 0) return null;
    return { slug: key.slice(0, sep), name: key.slice(sep + 1) };
  },
}));

// windowState — Shell + TopicBar gate the members aside / hamburger /
// nick count on the joined-channel predicate. Default to "joined for
// any channel" so existing tests that select a channel see the
// joined-state UI; suppression branches (DM/server/non-joined) are
// covered explicitly below. Sidebar also imports
// `windowStateByChannel` to drive its greyed/synthetic-row treatment;
// `windowStateMap` is mutable per-test so the /names UX cluster N-3
// auto-select-first-joined-channel effect can be exercised.
const mockWindowIsJoined = vi.fn((_key: string) => true);
const windowStateMap = vi.hoisted(() => ({
  current: {} as Record<string, "pending" | "joined" | "failed" | "kicked" | "parked">,
}));
vi.mock("../lib/windowState", () => ({
  windowStateByChannel: () => windowStateMap.current,
  windowFailureByChannel: () => ({}),
  windowKickedMetaByChannel: () => ({}),
  windowIsJoined: (key: string) => mockWindowIsJoined(key),
  isActiveChannelJoined: () => {
    const sel = selectionState.selSig();
    if (sel === null) return false;
    if (sel.kind !== "channel") return false;
    return mockWindowIsJoined(`${sel.networkSlug} ${sel.channelName}`);
  },
}));

import Shell from "../Shell";

beforeEach(async () => {
  vi.clearAllMocks();
  // UX-4 bucket M (2026-05-19) — vi.fn inside vi.mock factory isn't
  // always reset by clearAllMocks; clear explicitly so test-3's
  // "not called" assertion isn't poisoned by test-1's call.
  const orch = await import("../lib/imageUploadOrchestrator");
  vi.mocked(orch.loadUploadTtlSeconds).mockClear();
  selectionState.setSelSig(null);
  mobileState.value = false;
  mockWindowIsJoined.mockReturnValue(true);
  windowStateMap.current = {};
  // M-7 default — non-admin user. M-7 tests below opt in via mutation.
  userHolder.current = { kind: "user", id: "u1", name: "vjt", is_admin: false, inserted_at: "x" };
  // UX-4 bucket M default — no token unless a test opts in.
  tokenHolder.value = null;
});

describe("Shell — three-pane integration", () => {
  it("renders sidebar + main + members aside", () => {
    const { container } = render(() => <Shell />);
    expect(container.querySelector(".shell-sidebar")).toBeTruthy();
    expect(container.querySelector(".shell-main")).toBeTruthy();
    expect(container.querySelector(".shell-members")).toBeTruthy();
  });

  it("UX-4 B / N — cold-load synchronously lands on the home pane (no 'select a channel' fallback)", async () => {
    // Pre-UX-4-N this test asserted the empty-state fallback was
    // visible. That was an artefact of the broken Shell-test mock:
    // the old plain-object selectionState updated `.current` on
    // setSelectedChannel but did NOT notify Solid consumers, so the
    // bucket B cold-load auto-select call landed silently and the
    // fallback Show stayed true. UX-4 bucket N's pane-mount work
    // required upgrading the mock to a real Solid signal — which
    // surfaces the actual contract: cold-load synchronously lands on
    // home for every identity (visitor + registered), and the
    // fallback path is unreachable in practice. Pre-UX-4 the empty-
    // state fallback IS still rendered briefly before /me resolves;
    // here userHolder is seeded synchronously so the effect fires on
    // the first reactive tick.
    render(() => <Shell />);
    await waitFor(() => {
      expect(selectionState.setSelectedChannelMock).toHaveBeenCalledWith({
        networkSlug: "$home",
        channelName: "$home",
        kind: "home",
      });
    });
    // home pane is rendered, no "select a channel" fallback.
    expect(screen.queryByText(/select a channel/i)).toBeNull();
  });

  it("/names UX cluster N-3 — auto-selects first joined channel on cold load when nothing is selected", async () => {
    // UX-4 bucket B (2026-05-18) REPLACED this behavior: cold-load now
    // defaults to the `$home` window regardless of whether any channels
    // have reached `:joined`. The N-3 first-joined-channel selection is
    // superseded — operators wanting a specific channel click in the
    // sidebar, and the home pane itself is the new "landing window."
    //
    // Test rewritten to assert the new contract: cold-load lands on
    // home, NOT on the first joined channel.
    windowStateMap.current = { "freenode #a": "joined", "freenode #b": "joined" };
    render(() => <Shell />);
    await waitFor(() => {
      expect(selectionState.setSelectedChannelMock).toHaveBeenCalledWith({
        networkSlug: "$home",
        channelName: "$home",
        kind: "home",
      });
    });
  });

  it("UX-4 B — cold-load defaults to home even when no channel has reached :joined", async () => {
    // UX-4 B replacement for the prior N-3 "do nothing if no joined
    // channels" test. The new contract: cold-load ALWAYS lands on home,
    // independent of channel state. The empty-stub "select a channel"
    // fallback is no longer the cold-load endpoint.
    windowStateMap.current = { "freenode #a": "pending", "freenode #b": "pending" };
    render(() => <Shell />);
    await waitFor(() => {
      expect(selectionState.setSelectedChannelMock).toHaveBeenCalledWith({
        networkSlug: "$home",
        channelName: "$home",
        kind: "home",
      });
    });
  });

  it("/names UX cluster N-3 — does NOT override an existing selection", () => {
    // Operator has already picked a channel (via sidebar click or via
    // a prior auto-select that still holds). Even when more joined
    // channels exist, the effect must not re-fire and override.
    selectionState.setSelSig({ networkSlug: "freenode", channelName: "#b", kind: "channel" });
    windowStateMap.current = { "freenode #a": "joined", "freenode #b": "joined" };
    render(() => <Shell />);
    expect(selectionState.setSelectedChannelMock).not.toHaveBeenCalled();
  });

  it("renders TopicBar + ScrollbackPane + ComposeBox once a channel is selected", async () => {
    selectionState.setSelSig({ networkSlug: "freenode", channelName: "#a", kind: "channel" });
    render(() => <Shell />);
    await waitFor(() => {
      expect(screen.getByLabelText(/open members sidebar/i)).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText(/message #a/i)).toBeInTheDocument();
  });

  it("does NOT render TopicBar when the synthetic :server window is selected (channel-only per spec #20)", async () => {
    selectionState.setSelSig({ networkSlug: "freenode", channelName: ":server", kind: "server" });
    const { container } = render(() => <Shell />);
    // ScrollbackPane still renders (server window has its own scrollback).
    // CP13 S9 — ComposeBox now DOES render on $server (slash-only gate
    // enforced inside compose.ts), reverting the BUG 2d behavior.
    // TopicBar must NOT render — feature #20: channel-window-only.
    await waitFor(() => {
      expect(container.querySelector(".scrollback-pane")).toBeInTheDocument();
    });
    expect(container.querySelector(".topic-bar")).not.toBeInTheDocument();
    expect(container.querySelector(".compose-box")).toBeInTheDocument();
  });

  // CP13 S9: server window now accepts slash-commands via the regular
  // compose-box. Plain text is rejected inside compose.ts with a friendly
  // error. The compose-box itself must render on both desktop and mobile.
  it("CP13: compose-box IS rendered on desktop when server window is selected", async () => {
    selectionState.setSelSig({ networkSlug: "freenode", channelName: "$server", kind: "server" });
    const { container } = render(() => <Shell />);
    await waitFor(() => {
      expect(container.querySelector(".scrollback-pane")).toBeInTheDocument();
    });
    expect(container.querySelector(".compose-box")).toBeInTheDocument();
  });

  it("does NOT render TopicBar when a query window is selected (channel-only per spec #20)", async () => {
    selectionState.setSelSig({ networkSlug: "freenode", channelName: "alice", kind: "query" });
    const { container } = render(() => <Shell />);
    await waitFor(() => {
      expect(container.querySelector(".scrollback-pane")).toBeInTheDocument();
    });
    expect(container.querySelector(".topic-bar")).not.toBeInTheDocument();
  });

  it("Alt+1 selects the first flat channel via keybindings", async () => {
    render(() => <Shell />);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", altKey: true }));
    await waitFor(() => {
      expect(selectionState.setSelectedChannelMock).toHaveBeenCalledWith({
        networkSlug: "freenode",
        channelName: "#a",
        kind: "channel",
      });
    });
  });

  it("Alt+2 selects the second flat channel via keybindings", async () => {
    render(() => <Shell />);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", altKey: true }));
    await waitFor(() => {
      expect(selectionState.setSelectedChannelMock).toHaveBeenCalledWith({
        networkSlug: "freenode",
        channelName: "#b",
        kind: "channel",
      });
    });
  });

  it("UX-5 bucket A — Esc closes the members drawer (sidebar drawer dropped)", async () => {
    selectionState.setSelSig({ networkSlug: "freenode", channelName: "#a", kind: "channel" });
    const { container } = render(() => <Shell />);
    await waitFor(() => {
      expect(screen.getByLabelText(/open members sidebar/i)).toBeInTheDocument();
    });
    // Open members drawer via TopicBar hamburger
    fireEvent.click(screen.getByLabelText(/open members sidebar/i));
    expect(container.querySelector(".shell-members")?.classList.contains("open")).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await waitFor(() => {
      expect(container.querySelector(".shell-members")?.classList.contains("open")).toBe(false);
    });
  });

  it("clicking ⚙ opens SettingsDrawer (.open class)", async () => {
    selectionState.setSelSig({ networkSlug: "freenode", channelName: "#a", kind: "channel" });
    const { container } = render(() => <Shell />);
    await waitFor(() => {
      expect(screen.getByLabelText(/open settings/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText(/open settings/i));
    expect(container.querySelector(".settings-drawer")?.classList.contains("open")).toBe(true);
  });

  it("empty-state renders the ⚙ settings button", () => {
    render(() => <Shell />);
    expect(screen.getByLabelText(/open settings/i)).toBeInTheDocument();
  });

  it("clicking empty-state ⚙ opens the settings drawer", () => {
    const { container } = render(() => <Shell />);
    fireEvent.click(screen.getByLabelText(/open settings/i));
    const settings = container.querySelector(".settings-drawer");
    expect(settings?.classList.contains("open")).toBe(true);
  });

  // UX-5 bucket A (2026-05-19) — hamburger visibility matrix. Pre-
  // bucket Shell rendered a ShellChrome hamburger on both desktop +
  // mobile that duplicated TopicBar's members hamburger on mobile and
  // toggled a no-op `.open` class on desktop. Post-bucket: ZERO chrome
  // hamburgers on either branch; mobile members drawer lives in
  // TopicBar.tsx (channel-window-only).
  describe("UX-5 bucket A — hamburger visibility matrix", () => {
    it("desktop, no selection: 0 hamburgers (chrome hamburger dropped)", () => {
      mobileState.value = false;
      const { container } = render(() => <Shell />);
      expect(container.querySelectorAll(".shell-chrome-hamburger").length).toBe(0);
      expect(container.querySelectorAll(".topic-bar-hamburger").length).toBe(0);
      expect(screen.queryByLabelText(/open channel sidebar/i)).toBeNull();
    });

    it("desktop, channel selected: 0 chrome hamburgers, TopicBar hamburger in DOM (visibility gated by @media in e2e)", async () => {
      mobileState.value = false;
      selectionState.setSelSig({ networkSlug: "freenode", channelName: "#a", kind: "channel" });
      const { container } = render(() => <Shell />);
      await waitFor(() => {
        expect(container.querySelector(".topic-bar")).toBeInTheDocument();
      });
      expect(container.querySelectorAll(".shell-chrome-hamburger").length).toBe(0);
      // TopicBar's members hamburger always renders in the DOM for
      // joined channels; CSS @media gating handles desktop visibility.
      expect(container.querySelectorAll(".topic-bar-hamburger").length).toBe(1);
    });

    it("desktop, home selected: 0 hamburgers (no members surface)", async () => {
      mobileState.value = false;
      selectionState.setSelSig({ networkSlug: "$home", channelName: "$home", kind: "home" });
      const { container } = render(() => <Shell />);
      await waitFor(() => {
        expect(container.querySelector("[data-testid='shell-chrome']")).toBeInTheDocument();
      });
      expect(container.querySelectorAll(".shell-chrome-hamburger").length).toBe(0);
      expect(container.querySelectorAll(".topic-bar-hamburger").length).toBe(0);
    });
  });

  describe("members aside scope (joined-channel only)", () => {
    it("renders MembersPane inside .shell-members when a joined channel is selected", async () => {
      selectionState.setSelSig({ networkSlug: "freenode", channelName: "#a", kind: "channel" });
      mockWindowIsJoined.mockReturnValue(true);
      const { container } = render(() => <Shell />);
      await waitFor(() => {
        expect(container.querySelector(".shell-members .members-pane")).toBeTruthy();
      });
    });

    it("does NOT render MembersPane when the active channel is not joined (parked/failed/kicked)", async () => {
      selectionState.setSelSig({ networkSlug: "freenode", channelName: "#a", kind: "channel" });
      mockWindowIsJoined.mockReturnValue(false);
      const { container } = render(() => <Shell />);
      await waitFor(() => {
        expect(container.querySelector(".shell-main")).toBeTruthy();
      });
      expect(container.querySelector(".shell-members .members-pane")).toBeNull();
    });

    it("does NOT render MembersPane when a query (DM) window is selected", async () => {
      selectionState.setSelSig({ networkSlug: "freenode", channelName: "alice", kind: "query" });
      const { container } = render(() => <Shell />);
      await waitFor(() => {
        expect(container.querySelector(".shell-main")).toBeTruthy();
      });
      expect(container.querySelector(".shell-members .members-pane")).toBeNull();
    });

    it("does NOT render MembersPane when the server window is selected", async () => {
      selectionState.setSelSig({ networkSlug: "freenode", channelName: "$server", kind: "server" });
      const { container } = render(() => <Shell />);
      await waitFor(() => {
        expect(container.querySelector(".shell-main")).toBeTruthy();
      });
      expect(container.querySelector(".shell-members .members-pane")).toBeNull();
    });

    it("collapses the members grid column (.shell-no-members) when not joined", async () => {
      selectionState.setSelSig({ networkSlug: "freenode", channelName: "alice", kind: "query" });
      const { container } = render(() => <Shell />);
      await waitFor(() => {
        expect(container.querySelector(".shell.shell-no-members")).toBeTruthy();
      });
    });

    it("does NOT add .shell-no-members when a joined channel is selected", async () => {
      selectionState.setSelSig({ networkSlug: "freenode", channelName: "#a", kind: "channel" });
      mockWindowIsJoined.mockReturnValue(true);
      const { container } = render(() => <Shell />);
      await waitFor(() => {
        expect(container.querySelector(".shell-main")).toBeTruthy();
      });
      expect(container.querySelector(".shell.shell-no-members")).toBeNull();
    });
  });

  it("renders MentionsWindow (not ScrollbackPane) when kind === 'mentions'", async () => {
    selectionState.setSelSig({ networkSlug: "freenode", channelName: "", kind: "mentions" });
    const { container } = render(() => <Shell />);
    await waitFor(() => {
      expect(container.querySelector(".mentions-window")).toBeInTheDocument();
    });
    expect(container.querySelector(".scrollback-pane")).not.toBeInTheDocument();
    expect(container.querySelector(".compose-box")).not.toBeInTheDocument();
    expect(container.querySelector(".topic-bar")).not.toBeInTheDocument();
  });

  it("C8.2: clicking a mentions row switches focus to the source channel (CP29 R-4: cursor rewind dropped)", async () => {
    selectionState.setSelSig({ networkSlug: "freenode", channelName: "", kind: "mentions" });
    const { container } = render(() => <Shell />);
    await waitFor(() => {
      expect(container.querySelector(".mentions-window")).toBeInTheDocument();
    });
    const row = container.querySelector(".mentions-row");
    expect(row).toBeDefined();
    if (row) fireEvent.click(row);
    // Should navigate to the channel the mention came from.
    expect(selectionState.setSelectedChannelMock).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });
    // CP29 R-4: pre-flip the click set a localStorage cursor to
    // server_time-1 so ScrollbackPane scrolled to a marker just above
    // the clicked message. The new server-owned id-based cursor model
    // can't express that operation (no message id in MentionsBundle wire
    // shape; advance is forward-only). Drop documented in Shell.tsx;
    // restoring the UX requires extending MentionsBundle with ids and
    // threading a one-shot scroll-to verb — separate cluster.
  });
});

describe("Shell — mobile layout (isMobile = true)", () => {
  // C6.1: on mobile, shell-sidebar is NOT rendered in the DOM.
  // Channels live in the BottomBar; the left drawer goes away entirely.
  it("shell-sidebar is absent from the DOM on mobile", () => {
    mobileState.value = true;
    const { container } = render(() => <Shell />);
    expect(container.querySelector(".shell-sidebar")).toBeNull();
  });

  // C6.1: on mobile, a .bottom-bar element IS rendered (BottomBar).
  it("bottom-bar IS rendered on mobile", () => {
    mobileState.value = true;
    const { container } = render(() => <Shell />);
    expect(container.querySelector(".bottom-bar")).toBeTruthy();
  });

  // C6.3: on mobile, there is exactly ONE .topic-bar-hamburger (the members one).
  // The channel-sidebar hamburger is removed on mobile.
  it("exactly one .topic-bar-hamburger rendered on mobile (members only)", async () => {
    mobileState.value = true;
    selectionState.setSelSig({ networkSlug: "freenode", channelName: "#a", kind: "channel" });
    const { container } = render(() => <Shell />);
    await waitFor(() => {
      expect(container.querySelectorAll(".topic-bar-hamburger").length).toBe(1);
    });
  });

  // C6.3: on mobile, the single hamburger opens the members drawer.
  it("single hamburger on mobile opens members drawer", async () => {
    mobileState.value = true;
    selectionState.setSelSig({ networkSlug: "freenode", channelName: "#a", kind: "channel" });
    const { container } = render(() => <Shell />);
    await waitFor(() => {
      expect(container.querySelector(".topic-bar-hamburger")).toBeTruthy();
    });
    fireEvent.click(container.querySelector(".topic-bar-hamburger") as HTMLElement);
    expect(container.querySelector(".shell-members")?.classList.contains("open")).toBe(true);
  });

  // CP13 S9: server window now renders compose-box on mobile too — slash-only
  // gate is in compose.ts.
  it("CP13: compose-box IS rendered on mobile when server window is selected", async () => {
    mobileState.value = true;
    selectionState.setSelSig({ networkSlug: "freenode", channelName: "$server", kind: "server" });
    const { container } = render(() => <Shell />);
    await waitFor(() => {
      expect(container.querySelector(".scrollback-pane")).toBeInTheDocument();
    });
    expect(container.querySelector(".compose-box")).toBeInTheDocument();
  });

  // UX-5 bucket BT (2026-05-19) — narrow-mode chrome+topic compression.
  // BT inlined archive + cog into the TopicBar via `inlineChromeSlot`,
  // dropping the standalone `.shell-chrome` row on mobile-channel.
  //
  // UX-5 bucket BM (2026-05-20) — three buttons on a narrow row was
  // still crowded (vjt 2026-05-19 dogfood). BM compresses again:
  // archive + cog move OUT of the topic-bar and into a bottom-fixed
  // launcher footer inside the mobile members drawer. The topic-bar's
  // right edge now hosts ONLY the hamburger. Mutex `members | settings
  // | archive | none` enforced via lib/mobilePanel.ts. Non-channel
  // mobile windows (home / mentions / admin / server) STILL keep the
  // standalone `.shell-chrome` row (no members drawer to host the
  // launchers). Desktop is unchanged on every window kind.
  describe("UX-5 buckets BT + BM — narrow-mode chrome+topic compression", () => {
    it("mobile channel window: NO standalone .shell-chrome row; topic-bar hosts ONLY hamburger (no cog, no archive inline)", async () => {
      mobileState.value = true;
      selectionState.setSelSig({ networkSlug: "freenode", channelName: "#a", kind: "channel" });
      const { container } = render(() => <Shell />);
      await waitFor(() => {
        expect(container.querySelector(".topic-bar")).toBeInTheDocument();
      });
      // Standalone chrome row is NOT mounted in the channel-window branch.
      expect(container.querySelector(".shell-chrome")).toBeNull();
      // BM: cog + archive are NO LONGER inline in the topic-bar.
      expect(container.querySelector(".topic-bar [data-testid='shell-chrome-cog']")).toBeNull();
      expect(container.querySelector(".topic-bar [data-testid='shell-chrome-archive']")).toBeNull();
      // Only the hamburger survives on the topic-bar's right edge.
      expect(container.querySelector(".topic-bar .topic-bar-hamburger")).not.toBeNull();
    });

    it("mobile channel window: launcher footer in .shell-members hosts settings + archive launchers (network context present)", async () => {
      mobileState.value = true;
      selectionState.setSelSig({ networkSlug: "freenode", channelName: "#a", kind: "channel" });
      const { container } = render(() => <Shell />);
      await waitFor(() => {
        expect(container.querySelector(".shell-members .mobile-panel-actions")).toBeInTheDocument();
      });
      const footer = container.querySelector(".shell-members .mobile-panel-actions");
      expect(footer?.querySelector("[data-testid='mobile-panel-settings']")).not.toBeNull();
      expect(footer?.querySelector("[data-testid='mobile-panel-archive']")).not.toBeNull();
    });

    it("mobile home window: standalone .shell-chrome row STAYS (no TopicBar / drawer to absorb buttons)", async () => {
      mobileState.value = true;
      selectionState.setSelSig({ networkSlug: "$home", channelName: "$home", kind: "home" });
      const { container } = render(() => <Shell />);
      await waitFor(() => {
        expect(container.querySelector("[data-testid='shell-chrome']")).toBeInTheDocument();
      });
      expect(container.querySelector(".shell-chrome")).not.toBeNull();
      expect(container.querySelector(".topic-bar")).toBeNull();
    });

    it("desktop channel window: standalone .shell-chrome row STAYS; NO launcher footer inside members aside", async () => {
      mobileState.value = false;
      selectionState.setSelSig({ networkSlug: "freenode", channelName: "#a", kind: "channel" });
      const { container } = render(() => <Shell />);
      await waitFor(() => {
        expect(container.querySelector(".topic-bar")).toBeInTheDocument();
      });
      expect(container.querySelector(".shell-chrome")).not.toBeNull();
      // Desktop topic-bar must NOT inline the chrome buttons.
      expect(container.querySelector(".topic-bar [data-testid='shell-chrome-cog']")).toBeNull();
      // BM: desktop members aside has NO launcher footer (mobile-only).
      expect(container.querySelector(".shell-members .mobile-panel-actions")).toBeNull();
    });
  });

  // UX-6 bucket C (2026-05-21) — admin button in mobile drawer footer
  // (vjt iPhone-dogfood Bug 3). Pre-bucket the mobile launcher footer
  // hosted only settings + archive; admins had to open the LEFT
  // sidebar drawer and scroll to the 🔧 row to reach AdminPane on
  // mobile. Bucket adds a 4th launcher button gated on `isAdmin()`
  // mirroring the Sidebar admin row gate (single source of truth).
  // Tap dispatches the same selection-driven admin window navigation
  // that Sidebar + SettingsDrawer entries use ($admin/$admin/admin).
  describe("UX-6 bucket C — admin launcher button in mobile drawer footer", () => {
    it("admin user: launcher footer hosts admin button alongside settings + archive", async () => {
      mobileState.value = true;
      userHolder.current = {
        kind: "user",
        id: "u1",
        name: "vjt",
        is_admin: true,
        inserted_at: "x",
      };
      selectionState.setSelSig({ networkSlug: "freenode", channelName: "#a", kind: "channel" });
      const { container } = render(() => <Shell />);
      await waitFor(() => {
        expect(container.querySelector(".shell-members .mobile-panel-actions")).toBeInTheDocument();
      });
      const footer = container.querySelector(".shell-members .mobile-panel-actions");
      expect(footer?.querySelector("[data-testid='mobile-panel-admin']")).not.toBeNull();
    });

    it("non-admin user: launcher footer does NOT render the admin button", async () => {
      mobileState.value = true;
      userHolder.current = {
        kind: "user",
        id: "u1",
        name: "vjt",
        is_admin: false,
        inserted_at: "x",
      };
      selectionState.setSelSig({ networkSlug: "freenode", channelName: "#a", kind: "channel" });
      const { container } = render(() => <Shell />);
      await waitFor(() => {
        expect(container.querySelector(".shell-members .mobile-panel-actions")).toBeInTheDocument();
      });
      const footer = container.querySelector(".shell-members .mobile-panel-actions");
      expect(footer?.querySelector("[data-testid='mobile-panel-admin']")).toBeNull();
    });

    it("admin tap: dispatches selection to $admin window (same handler as Sidebar admin row)", async () => {
      mobileState.value = true;
      userHolder.current = {
        kind: "user",
        id: "u1",
        name: "vjt",
        is_admin: true,
        inserted_at: "x",
      };
      selectionState.setSelSig({ networkSlug: "freenode", channelName: "#a", kind: "channel" });
      const { container } = render(() => <Shell />);
      const btn = await waitFor(() => {
        const b = container.querySelector<HTMLButtonElement>(
          ".shell-members .mobile-panel-actions [data-testid='mobile-panel-admin']",
        );
        expect(b).not.toBeNull();
        return b as HTMLButtonElement;
      });
      fireEvent.click(btn);
      expect(selectionState.setSelectedChannelMock).toHaveBeenCalledWith({
        networkSlug: "$admin",
        channelName: "$admin",
        kind: "admin",
      });
    });

    it("admin tap: closes the members drawer (mutex with settings/archive)", async () => {
      mobileState.value = true;
      userHolder.current = {
        kind: "user",
        id: "u1",
        name: "vjt",
        is_admin: true,
        inserted_at: "x",
      };
      selectionState.setSelSig({ networkSlug: "freenode", channelName: "#a", kind: "channel" });
      const { container } = render(() => <Shell />);
      // Open the drawer first via TopicBar hamburger (BM mutex).
      const hamburger = await waitFor(() => {
        const h = container.querySelector<HTMLButtonElement>(".topic-bar .topic-bar-hamburger");
        expect(h).not.toBeNull();
        return h as HTMLButtonElement;
      });
      fireEvent.click(hamburger);
      await waitFor(() => {
        expect(container.querySelector(".shell-members.open")).not.toBeNull();
      });
      const btn = container.querySelector<HTMLButtonElement>(
        ".shell-members .mobile-panel-actions [data-testid='mobile-panel-admin']",
      );
      expect(btn).not.toBeNull();
      fireEvent.click(btn as HTMLButtonElement);
      // Same mutex shape as openSettingsPanel — drawer closes before
      // navigating to the launched surface.
      await waitFor(() => {
        expect(container.querySelector(".shell-members.open")).toBeNull();
      });
    });
  });
});

// M-cluster M-7 — admin pane lifecycle on Shell. The drawer entry +
// pane content live in SettingsDrawer.test.tsx + AdminPane.test.tsx
// respectively; these tests pin the Shell-level wiring: pane mounts
// when admin clicks the drawer entry, replaces channel content,
// auto-redirects to home on demote.
//
// UX-4 bucket N (2026-05-19) — pane mount is now selection-driven:
// `<Show when={sel.kind === "admin" && isAdmin()}>`. The drawer
// "admin console" entry sets selection to the admin window; the
// dedicated sidebar admin row does the same. Demote-mid-session
// redirects selection back to home (was: flip adminOpen=false; now:
// setSelectedChannel(home), which collapses the admin Show AND lands
// the operator on a deterministic window). Tests below pin both paths.
describe("Shell — M-7/N admin pane lifecycle", () => {
  it("does NOT render the admin pane for a non-admin user even after settings open", () => {
    userHolder.current = { kind: "user", id: "u1", name: "vjt", is_admin: false, inserted_at: "x" };
    selectionState.setSelSig({ networkSlug: "freenode", channelName: "#a", kind: "channel" });
    const { container } = render(() => <Shell />);
    expect(container.querySelector(".admin-pane")).toBeNull();
    // Drawer entry hidden for non-admin (gated in SettingsDrawer).
    expect(container.querySelector(".admin-console-entry")).toBeNull();
  });

  it("admin user can open the admin pane via the drawer entry; channel pane unmounts", async () => {
    userHolder.current = { kind: "user", id: "u1", name: "vjt", is_admin: true, inserted_at: "x" };
    selectionState.setSelSig({ networkSlug: "freenode", channelName: "#a", kind: "channel" });
    const { container } = render(() => <Shell />);
    // Pre-click — channel content visible, no admin pane.
    expect(container.querySelector(".admin-pane")).toBeNull();
    expect(container.querySelector(".scrollback-pane")).toBeInTheDocument();
    // Open settings overlay → click admin console entry.
    fireEvent.click(screen.getByLabelText(/open settings/i));
    const entry = await screen.findByTestId("admin-console-entry");
    fireEvent.click(entry);
    // UX-4 bucket N — selection-driven: drawer entry sets selection to
    // admin window. Shell's `<Show when={sel.kind === "admin" && isAdmin()}>`
    // flips true on the next reactive cycle.
    await waitFor(() => {
      expect(selectionState.setSelectedChannelMock).toHaveBeenCalledWith({
        networkSlug: "$admin",
        channelName: "$admin",
        kind: "admin",
      });
    });
    await waitFor(() => {
      expect(container.querySelector(".admin-pane")).toBeInTheDocument();
    });
    // Channel content must yield — admin pane replaces the main pane.
    expect(container.querySelector(".scrollback-pane")).toBeNull();
  });

  it("clicking admin pane close button returns to home (selection-driven)", async () => {
    userHolder.current = { kind: "user", id: "u1", name: "vjt", is_admin: true, inserted_at: "x" };
    // Start on admin window directly — equivalent to the post-drawer-
    // entry state. Avoids re-asserting the drawer wiring here (covered
    // by the prior test).
    selectionState.setSelSig({ networkSlug: "$admin", channelName: "$admin", kind: "admin" });
    const { container } = render(() => <Shell />);
    await waitFor(() => expect(container.querySelector(".admin-pane")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("admin-pane-close"));
    // UX-4 bucket N — onClose navigates selection to home.
    expect(selectionState.setSelectedChannelMock).toHaveBeenCalledWith({
      networkSlug: "$home",
      channelName: "$home",
      kind: "home",
    });
  });

  it("UX-4 N — demote-mid-session redirects selection to home when on admin window", async () => {
    // Admin operator currently sitting on the admin window.
    userHolder.current = { kind: "user", id: "u1", name: "vjt", is_admin: true, inserted_at: "x" };
    selectionState.setSelSig({ networkSlug: "$admin", channelName: "$admin", kind: "admin" });
    render(() => <Shell />);
    // Demote: flip is_admin to false on the same holder. userHolder is
    // backed by a real Solid signal, so Shell's demote effect (which
    // reads isAdmin → user()) observes the flip and redirects to home.
    userHolder.current = {
      kind: "user",
      id: "u1",
      name: "vjt",
      is_admin: false,
      inserted_at: "x",
    };
    await waitFor(() => {
      expect(selectionState.setSelectedChannelMock).toHaveBeenCalledWith({
        networkSlug: "$home",
        channelName: "$home",
        kind: "home",
      });
    });
  });
});

// UX-4 bucket M (2026-05-19) — Shell.tsx's post-login bootstrap effect
// calls loadUploadTtlSeconds once when BOTH token + /me have resolved.
// Without this, the operator's saved upload-TTL preference would
// silently default to host.defaultTtl on the first upload after every
// page reload (until the SettingsDrawer was opened at least once).
// NOTE: SettingsDrawer also calls loadUploadTtlSeconds in onMount
// (drawer is mounted inside Shell even when closed, so its onMount
// fires regardless). These tests assert the SHELL bootstrap fires
// independently — the assertion is "at least one call when conditions
// met" + "exact call shape" rather than count-strict.
describe("Shell — upload-TTL bootstrap (UX-4 bucket M)", () => {
  it("loads the server preference when token + user are both present", async () => {
    const orch = await import("../lib/imageUploadOrchestrator");
    tokenHolder.value = "test-bearer";
    userHolder.current = { kind: "user", id: "u1", name: "vjt", is_admin: false, inserted_at: "x" };

    render(() => <Shell />);

    await waitFor(() => {
      expect(orch.loadUploadTtlSeconds).toHaveBeenCalledWith("test-bearer");
    });
  });

  it("does NOT load via the Shell-level bootstrap when token is absent", async () => {
    const orch = await import("../lib/imageUploadOrchestrator");
    tokenHolder.value = null;
    userHolder.current = { kind: "user", id: "u1", name: "vjt", is_admin: false, inserted_at: "x" };

    render(() => <Shell />);

    // SettingsDrawer's onMount ALSO gates on token() !== null, so with
    // no token there's no call from either source.
    await Promise.resolve();
    expect(orch.loadUploadTtlSeconds).not.toHaveBeenCalled();
  });
});
