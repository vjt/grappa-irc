import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockNetworkConnectionState: Record<string, string | undefined> = {};
let mockNetworkConnectionReason: Record<string, string | null | undefined> = {};
// UX-4 bucket N — mutable holder so individual tests can flip the
// admin gate on/off. `isAdmin()` in Sidebar drives the new admin row
// visibility; default false to keep pre-N tests unchanged.
const adminHolder = vi.hoisted(() => ({ value: false }));
// #243 — controllable re-tap predicate. The handler fires the scroll-to-
// bottom command only when isActiveSelection(target) is true; the equality
// itself is proven in selection.test.ts, so here we drive the branch
// directly and assert the handler wiring (which branch calls the command,
// and the tuple it passes to the predicate).
const isActiveSelectionMock = vi.hoisted(() => vi.fn<(next: unknown) => boolean>());

vi.mock("../lib/networks", () => ({
  networks: () => [
    {
      // Bucket F H4: Network is now a discriminated union; the Sidebar
      // narrows on `kind === "user"` before reading connection_state.
      // Tests here exercise the user branch — visitors don't have a
      // connection_state to grey out, so the visitor variant is
      // covered by an explicit absence test below.
      kind: "user",
      id: 1,
      slug: "freenode",
      nick: "vjt",
      inserted_at: "",
      updated_at: "",
      connection_state_changed_at: null,
      get connection_state() {
        return mockNetworkConnectionState.freenode ?? "connected";
      },
      get connection_state_reason() {
        return mockNetworkConnectionReason.freenode ?? null;
      },
    },
  ],
  channelsBySlug: () => ({
    freenode: [
      { name: "#italia", joined: true, source: "autojoin" },
      { name: "#azzurra", joined: false, source: "autojoin" },
      { name: "#bnc", joined: true, source: "joined" },
    ],
  }),
  networkBySlug: (slug: string) => {
    if (slug !== "freenode") return undefined;
    return {
      kind: "user",
      id: 1,
      slug: "freenode",
      nick: "vjt",
      inserted_at: "",
      updated_at: "",
      connection_state: mockNetworkConnectionState.freenode ?? "connected",
      connection_state_reason: mockNetworkConnectionReason.freenode ?? null,
      connection_state_changed_at: null,
    };
  },
  // UX-4 bucket N — Sidebar imports `isAdmin` to gate the new admin
  // row. Default false; tests for the admin row flip the holder.
  isAdmin: () => adminHolder.value,
}));

vi.mock("../lib/selection", () => ({
  selectedChannel: () => null,
  setSelectedChannel: vi.fn(),
  isActiveSelection: (next: unknown) => isActiveSelectionMock(next),
  unreadCounts: () => ({ "freenode #bnc": 3 }),
  messagesUnread: () => ({ "freenode #bnc": 3, "freenode $server": 7 }),
  eventsUnread: () => ({ "freenode $server": 2 }),
  applySeedEnvelope: vi.fn(),
}));

// #243 — the scroll-to-bottom command bridge. Spied so the re-tap wiring
// tests can assert the handler bumps it (or not).
vi.mock("../lib/scrollToBottomCommand", () => ({
  requestScrollToBottom: vi.fn(),
  scrollToBottomRequest: () => 0,
}));

vi.mock("../lib/mentions", () => ({
  mentionCounts: () => ({ "freenode #italia": 2, "freenode $server": 1 }),
  setServerMention: vi.fn(),
}));

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
  decodeChannelKey: (key: string) => {
    const sepIdx = key.indexOf(" ");
    if (sepIdx < 0) return null;
    return { slug: key.slice(0, sepIdx), name: key.slice(sepIdx + 1) };
  },
}));

vi.mock("../lib/queryWindows", () => ({
  queryWindowsByNetwork: () => ({
    1: [
      { targetNick: "alice", openedAt: "2026-05-04T10:00:00Z" },
      { targetNick: "bob", openedAt: "2026-05-04T11:00:00Z" },
    ],
  }),
  closeQueryWindowState: vi.fn(),
  openQueryWindowState: vi.fn(),
  setQueryWindowsByNetwork: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  postPart: vi.fn().mockResolvedValue(undefined),
  listArchive: vi.fn(),
  // UX-4 bucket D — disconnectNetwork in lib/windowClose hits patchNetwork
  // (registered branch) or quitAll → patchNetwork (visitor branch). Real
  // windowClose is intentionally NOT mocked so the close-button wiring is
  // tested end-to-end; mock patchNetwork to silence the network call.
  patchNetwork: vi.fn().mockResolvedValue({}),
  // 2026-06-01 (unread-badges-from-cursor cluster, bucket B2):
  // selection.ts now imports isContentKind from api.ts for the badge
  // memo derivation. Any test importing selection (directly or
  // transitively) needs the classifier in its api mock.
  isContentKind: (k: string) => k === "privmsg" || k === "notice" || k === "action",
  isPresenceKind: (k: string) => !(k === "privmsg" || k === "notice" || k === "action"),
}));

vi.mock("../lib/archive", () => ({
  archivedBySlug: () => ({
    freenode: [
      { target: "#sniffo", kind: "channel", last_activity: 200, row_count: 576 },
      { target: "vjt-peer", kind: "query", last_activity: 100, row_count: 8 },
    ],
  }),
  loadArchive: vi.fn().mockResolvedValue(undefined),
  clearArchive: vi.fn(),
  visibleArchiveForNetwork: (slug: string) =>
    slug === "freenode"
      ? [
          { target: "#sniffo", kind: "channel", last_activity: 200, row_count: 576 },
          { target: "vjt-peer", kind: "query", last_activity: 100, row_count: 8 },
        ]
      : [],
}));

let mockSubject: { kind: "user" | "visitor"; [k: string]: unknown } | null = {
  kind: "user",
  id: "u-1",
  name: "alice",
};

vi.mock("../lib/auth", () => ({
  token: () => "tok",
  socketUserName: () => "alice",
  // UX-4 bucket D — windowClose.disconnectNetwork reads getSubject()
  // to branch visitor → quitAll vs user → patchNetwork(parked).
  getSubject: () => mockSubject,
  logout: vi.fn().mockResolvedValue(undefined),
}));

let mockAwayByNetwork: Record<string, boolean> = {};

vi.mock("../lib/awayStatus", () => ({
  awayByNetwork: () => mockAwayByNetwork,
  setAwayState: vi.fn(),
}));

let mockWindowState: Record<string, string> = {};

const setPartedMock = vi.fn();

vi.mock("../lib/windowState", () => ({
  windowStateByChannel: () => mockWindowState,
  setParted: (...args: unknown[]) => setPartedMock(...args),
}));

import * as apiMod from "../lib/api";
import * as archiveMod from "../lib/archive";
// #195 — the confirm-dialog store, imported STATICALLY so the test shares the
// SAME module instance windowClose writes to on × click (a dynamic
// `await import` would resolve a second instance under vitest's mocked graph
// and never reflect the requestConfirm write).
import { acceptConfirm, confirmRequest, dismissConfirm } from "../lib/confirmDialog";
// Capture mocked module references at import time, before any resetModules
import * as qwMod from "../lib/queryWindows";
import * as scrollCmd from "../lib/scrollToBottomCommand";
import * as selMod from "../lib/selection";
// windowKinds is NOT mocked — import constants from the real module.
import { LIST_WINDOW_NAME } from "../lib/windowKinds";
import Sidebar from "../Sidebar";

beforeEach(() => {
  vi.clearAllMocks();
  mockWindowState = {};
  mockNetworkConnectionState = {};
  mockNetworkConnectionReason = {};
  mockAwayByNetwork = {};
  adminHolder.value = false;
  // #243 — default "not the active window" so existing click tests (which
  // just assert setSelectedChannel) never trip the scroll-to-bottom branch.
  isActiveSelectionMock.mockReturnValue(false);
});

describe("Sidebar", () => {
  it("renders all channels grouped by network", () => {
    render(() => <Sidebar />);
    expect(screen.getByText("#italia")).toBeInTheDocument();
    expect(screen.getByText("#azzurra")).toBeInTheDocument();
    expect(screen.getByText("#bnc")).toBeInTheDocument();
    expect(screen.getByText("freenode")).toBeInTheDocument();
  });

  it("parted channels (joined: false) get the .parted class", () => {
    render(() => <Sidebar />);
    const parted = screen.getByText("#azzurra");
    expect(parted.classList.contains("parted")).toBe(true);
  });

  it("joined channels do NOT get the .parted class", () => {
    render(() => <Sidebar />);
    const joined = screen.getByText("#italia");
    expect(joined.classList.contains("parted")).toBe(false);
  });

  it("renders unread count for channels with messages while away", () => {
    render(() => <Sidebar />);
    // Scope to the #bnc <li> — the Server <li> also has a msg-unread badge
    // since CP13 (S8). The test asserts the channel-side badge specifically.
    const bncLi = screen.getByText("#bnc").closest("li");
    const unread = bncLi?.querySelector(".sidebar-msg-unread");
    expect(unread?.textContent).toBe("3");
  });

  it("renders mention badge with @-prefix for channels with mentions", () => {
    render(() => <Sidebar />);
    const italiaLi = screen.getByText("#italia").closest("li");
    const mention = italiaLi?.querySelector(".sidebar-mention");
    expect(mention?.textContent).toBe("@2");
  });

  // CP13 — server window also surfaces the 3 badge classes (msg-unread,
  // events-unread, mention) so server-routed numerics + NickServ + MOTD
  // get the same unread treatment as channels.
  //
  // UX-4 bucket C — the server window is now the collapsed network-header
  // row. "Server" is gone as a literal label; the row displays the network
  // slug instead. Find via the header `<li class="sidebar-network-header">`.
  it("renders all 3 badge classes on the Server window when counts present", () => {
    render(() => <Sidebar />);
    const serverLi = screen.getByText("freenode").closest("li.sidebar-network-header");
    expect(serverLi).not.toBeNull();
    const msg = serverLi?.querySelector(".sidebar-msg-unread");
    const events = serverLi?.querySelector(".sidebar-events-unread");
    const mention = serverLi?.querySelector(".sidebar-mention");
    expect(msg?.textContent).toBe("7");
    expect(events?.textContent).toBe("2");
    expect(mention?.textContent).toBe("@1");
  });

  it("clicking a channel calls setSelectedChannel (UX-5 bucket A: onSelect prop dropped)", async () => {
    const sel = await import("../lib/selection");
    render(() => <Sidebar />);
    fireEvent.click(screen.getByText("#italia"));
    expect(sel.setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channelName: "#italia",
      kind: "channel",
    });
  });

  // #243 — re-tapping the ALREADY-active sidebar row is an irssi-parity
  // "jump to latest": it fires the scroll-to-bottom command. A tap that
  // SWITCHES channels must not (existing behaviour, no scroll authority
  // perturbation). Equality is proven in selection.test.ts; this pins the
  // handler wiring.
  describe("#243 — re-tap active row scrolls scrollback to bottom", () => {
    it("re-tapping the active channel row fires requestScrollToBottom with the tapped tuple", () => {
      isActiveSelectionMock.mockReturnValue(true);
      render(() => <Sidebar />);
      fireEvent.click(screen.getByText("#italia"));
      expect(isActiveSelectionMock).toHaveBeenCalledWith({
        networkSlug: "freenode",
        channelName: "#italia",
        kind: "channel",
      });
      expect(scrollCmd.requestScrollToBottom).toHaveBeenCalledTimes(1);
      // Still calls the (idempotent) selection setter — re-tap is a no-op
      // transition there, so ordering vs the scroll command doesn't matter.
      expect(selMod.setSelectedChannel).toHaveBeenCalledWith({
        networkSlug: "freenode",
        channelName: "#italia",
        kind: "channel",
      });
    });

    it("tapping a DIFFERENT (non-active) channel row does NOT fire requestScrollToBottom", () => {
      isActiveSelectionMock.mockReturnValue(false);
      render(() => <Sidebar />);
      fireEvent.click(screen.getByText("#azzurra"));
      expect(scrollCmd.requestScrollToBottom).not.toHaveBeenCalled();
      expect(selMod.setSelectedChannel).toHaveBeenCalledWith({
        networkSlug: "freenode",
        channelName: "#azzurra",
        kind: "channel",
      });
    });
  });

  it("renders 'no networks' fallback when networks list is empty", async () => {
    vi.resetModules();
    vi.doMock("../lib/networks", () => ({
      networks: () => [],
      channelsBySlug: () => ({}),
      isAdmin: () => false,
    }));
    vi.doMock("../lib/selection", () => ({
      selectedChannel: () => null,
      setSelectedChannel: vi.fn(),
      isActiveSelection: () => false,
      unreadCounts: () => ({}),
      messagesUnread: () => ({}),
      eventsUnread: () => ({}),
    }));
    vi.doMock("../lib/mentions", () => ({
      mentionCounts: () => ({}),
      setServerMention: vi.fn(),
    }));
    vi.doMock("../lib/queryWindows", () => ({
      queryWindowsByNetwork: () => ({}),
      closeQueryWindowState: vi.fn(),
      openQueryWindowState: vi.fn(),
      setQueryWindowsByNetwork: vi.fn(),
    }));
    const { default: SidebarFresh } = await import("../Sidebar");
    render(() => <SidebarFresh />);
    expect(screen.getByText(/no networks/i)).toBeInTheDocument();
  });

  // C1.2: Query windows appear in sidebar
  it("renders query windows (alice, bob) for the network", () => {
    render(() => <Sidebar />);
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
  });

  // UX-4 bucket D — the network-header row (formerly the standalone
  // server-row) IS closeable. Click dispatches `disconnectNetwork`
  // which routes to /quit for visitors and PATCH :parked for users.
  // Selection auto-redirects to home via selection.ts effect.
  it("server window has a close button (UX-4 bucket D)", () => {
    render(() => <Sidebar />);
    const li = screen.getByText("freenode").closest("li.sidebar-network-header");
    expect(li?.querySelector(".sidebar-close")).not.toBeNull();
  });

  // C1.2: Channel windows have a close button
  it("channel windows have a close button", () => {
    render(() => <Sidebar />);
    const channelEntry = screen.getByText("#italia");
    const li = channelEntry.closest("li");
    expect(li?.querySelector(".sidebar-close")).toBeTruthy();
  });

  // C1.2: Query windows have a close button
  it("query windows have a close button", () => {
    render(() => <Sidebar />);
    const queryEntry = screen.getByText("alice");
    const li = queryEntry.closest("li");
    expect(li?.querySelector(".sidebar-close")).toBeTruthy();
  });

  // C1.2: Clicking X on a query window calls closeQueryWindowState
  it("clicking close on query window calls closeQueryWindowState", () => {
    render(() => <Sidebar />);
    const aliceEntry = screen.getByText("alice");
    const li = aliceEntry.closest("li");
    const closeBtn = li?.querySelector(".sidebar-close") as HTMLElement;
    fireEvent.click(closeBtn);
    expect(qwMod.closeQueryWindowState).toHaveBeenCalledWith(1, "alice");
  });

  // #195 — clicking × on a channel opens the leave-confirm modal; the PART
  // (postPart) fires only on affirmative confirm, never on the bare click.
  // Replaces the pre-#195 instant-PART (and the #172 hold gate). Sidebar is
  // rendered in isolation here (no <ConfirmModal>), so we drive the real
  // confirmDialog store directly to assert the gate.
  it("clicking close on channel opens a leave-confirm modal; confirming calls postPart (#195)", () => {
    dismissConfirm();
    render(() => <Sidebar />);
    const italiaEntry = screen.getByText("#italia");
    const li = italiaEntry.closest("li");
    const closeBtn = li?.querySelector(".sidebar-close") as HTMLElement;
    fireEvent.click(closeBtn);
    // Modal requested with the interpolated channel name; PART NOT yet fired.
    expect(confirmRequest()?.body).toBe("Do you want to leave #italia?");
    expect(apiMod.postPart).not.toHaveBeenCalled();
    // Confirming fires the PART.
    acceptConfirm();
    expect(apiMod.postPart).toHaveBeenCalledWith("tok", "freenode", "#italia");
  });

  // CP15 B4 — Archive section per network. Collapsed by default
  // (`<details>` without `open`), lazy-loaded on first expand
  // (`loadArchive(slug)`), entries clickable → setSelectedChannel.
  describe("Archive section", () => {
    it("renders Archive <details> per network, collapsed by default", () => {
      render(() => <Sidebar />);
      const archive = screen.getByText("Archive");
      const details = archive.closest("details") as HTMLDetailsElement | null;
      expect(details).toBeTruthy();
      expect(details?.open).toBe(false);
    });

    it("renders one button per archived entry inside the network section", () => {
      render(() => <Sidebar />);
      // Both entries are rendered eagerly (the renderer reads from
      // `archivedBySlug()` which the test mock pre-populates). Lazy
      // FETCH still happens on expand; the renderer doesn't wait.
      expect(screen.getByText("#sniffo")).toBeInTheDocument();
      expect(screen.getByText("vjt-peer")).toBeInTheDocument();
    });

    it("expanding the Archive <details> calls loadArchive(slug)", () => {
      render(() => <Sidebar />);
      const archive = screen.getByText("Archive");
      const details = archive.closest("details") as HTMLDetailsElement;
      details.open = true;
      // Solid handlers fire on the toggle event, not on the property set.
      details.dispatchEvent(new Event("toggle"));
      expect(archiveMod.loadArchive).toHaveBeenCalledWith("freenode");
    });

    it("clicking an archived channel entry sets selection with kind=channel", () => {
      render(() => <Sidebar />);
      fireEvent.click(screen.getByText("#sniffo"));
      expect(selMod.setSelectedChannel).toHaveBeenCalledWith({
        networkSlug: "freenode",
        channelName: "#sniffo",
        kind: "channel",
      });
    });

    it("clicking an archived query entry sets selection with kind=query", () => {
      render(() => <Sidebar />);
      fireEvent.click(screen.getByText("vjt-peer"));
      expect(selMod.setSelectedChannel).toHaveBeenCalledWith({
        networkSlug: "freenode",
        channelName: "vjt-peer",
        kind: "query",
      });
    });
  });

  // CP15 B5 — windowState visual cues. Failed/kicked/parked channels +
  // queries get `.sidebar-window-greyed` on the row's button. Pending
  // channels NOT yet in `channelsBySlug` (operator just clicked JOIN
  // and waiting for the upstream echo) render as a synthetic sidebar
  // row so the operator sees immediate feedback. The actual joined
  // list still flows from `channelsBySlug` (heartbeat refetch).
  describe("CP15 B5 — windowState visual cues", () => {
    it("channel rows get .sidebar-window-greyed when state=failed", () => {
      mockWindowState = { "freenode #italia": "failed" };
      render(() => <Sidebar />);
      const li = screen.getByText("#italia").closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(true);
    });

    it("channel rows get .sidebar-window-greyed when state=kicked", () => {
      mockWindowState = { "freenode #italia": "kicked" };
      render(() => <Sidebar />);
      const li = screen.getByText("#italia").closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(true);
    });

    it("channel rows get .sidebar-window-greyed when state=parked", () => {
      mockWindowState = { "freenode #italia": "parked" };
      render(() => <Sidebar />);
      const li = screen.getByText("#italia").closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(true);
    });

    it("invited pseudo-rows expose data-window-state='invited' (genuine-gate seam, #78)", () => {
      // The pseudo-row carries its discrete state as a DOM seam so an e2e
      // can pin the :invited derivation specifically — `.sidebar-window-greyed`
      // alone is shared by every not-joined state, so asserting only the class
      // can't tell :invited from pending/failed/kicked/parked. #invited-room is
      // NOT in the mocked channelsBySlug, so it renders as a synthetic pseudo-row.
      mockWindowState = { "freenode #invited-room": "invited" };
      render(() => <Sidebar />);
      const li = screen.getByText("#invited-room").closest("li");
      expect(li?.getAttribute("data-window-state")).toBe("invited");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(true);
    });

    it("channel rows do NOT get .sidebar-window-greyed when state=joined", () => {
      mockWindowState = { "freenode #italia": "joined" };
      render(() => <Sidebar />);
      const li = screen.getByText("#italia").closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(false);
    });

    it("channel rows do NOT get .sidebar-window-greyed when no state entry", () => {
      mockWindowState = {};
      render(() => <Sidebar />);
      const li = screen.getByText("#italia").closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(false);
    });

    it("query rows get .sidebar-window-greyed when state=failed (DM target gone)", () => {
      // DMs don't transition to failed in the IRC sense, but the state
      // map shape is the same — apply uniformly so future state kinds
      // ride the same render branch without per-kind plumbing.
      mockWindowState = { "freenode alice": "kicked" };
      render(() => <Sidebar />);
      const li = screen.getByText("alice").closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(true);
    });

    it("renders a pending sidebar row for a channel in state=pending NOT yet in channelsBySlug", () => {
      // Operator clicked JOIN — networks.ts setPending fires; the
      // sidebar shows the row immediately (visual feedback). When the
      // server emits `joined`, channelsBySlug refetches via the
      // channels_changed heartbeat and the same row continues life
      // under the channelsBySlug branch (state transitions from
      // pending → joined and the greyed class falls off).
      mockWindowState = { "freenode #new-room": "pending" };
      render(() => <Sidebar />);
      expect(screen.getByText("#new-room")).toBeInTheDocument();
    });

    it("does NOT duplicate a pending row when the channel IS already in channelsBySlug", () => {
      // #italia is in channelsBySlug + state=pending. The row should
      // appear EXACTLY ONCE — channelsBySlug branch wins; the synthetic
      // pending row only fires when channelsBySlug doesn't already
      // carry the channel.
      mockWindowState = { "freenode #italia": "pending" };
      render(() => <Sidebar />);
      const matches = screen.getAllByText("#italia");
      expect(matches.length).toBe(1);
    });
  });

  // CP19 T32 parked-window — per-network derivation overlay. When the
  // network's credential `connection_state ∈ {parked, failed}`, the
  // network header gets `.sidebar-network-greyed` AND every channel/
  // query row under it derives as greyed regardless of its individual
  // `windowStateByChannel` entry. Source: `networkBySlug[slug]` (refreshed
  // via the user-topic `connection_state_changed` event arm in
  // `userTopic.ts`). Per CLAUDE.md "Don't duplicate state — derive it"
  // — the cascade is one conditional in `isGreyed`, not a parallel state
  // map. Symmetric on `:failed` (server-side terminal failure).
  //
  // UX-5 BH (2026-05-19): the legacy `<section class="sidebar-network">`
  // wrapper was killed; the per-network `<ul>` now carries
  // `.sidebar-network-section` + the `.sidebar-network-greyed` class.
  // `.closest("section")` is replaced by `.closest(".sidebar-network-section")`.
  describe("CP19 T32 — per-network parked/failed derivation overlay", () => {
    it("network header gets .sidebar-network-greyed when connection_state=parked", () => {
      mockNetworkConnectionState = { freenode: "parked" };
      render(() => <Sidebar />);
      const header = screen.getByText("freenode").closest(".sidebar-network-section");
      expect(header?.classList.contains("sidebar-network-greyed")).toBe(true);
    });

    it("network header gets .sidebar-network-greyed when connection_state=failed", () => {
      mockNetworkConnectionState = { freenode: "failed" };
      render(() => <Sidebar />);
      const header = screen.getByText("freenode").closest(".sidebar-network-section");
      expect(header?.classList.contains("sidebar-network-greyed")).toBe(true);
    });

    it("network header does NOT get .sidebar-network-greyed when connection_state=connected", () => {
      mockNetworkConnectionState = { freenode: "connected" };
      render(() => <Sidebar />);
      const header = screen.getByText("freenode").closest(".sidebar-network-section");
      expect(header?.classList.contains("sidebar-network-greyed")).toBe(false);
    });

    it("channel rows cascade greyed when network is parked, even if window state is joined", () => {
      // Critical derivation rule: stale `windowStateByChannel` entries
      // (which retain the pre-park values until the GenServer is dead +
      // a reconnect re-emits) MUST NOT win over the network-level park.
      // If they did, /disconnect would leave channels visually live.
      mockNetworkConnectionState = { freenode: "parked" };
      mockWindowState = { "freenode #italia": "joined" };
      render(() => <Sidebar />);
      const li = screen.getByText("#italia").closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(true);
    });

    it("channel rows cascade greyed when network is failed, even with no window state entry", () => {
      mockNetworkConnectionState = { freenode: "failed" };
      mockWindowState = {};
      render(() => <Sidebar />);
      const li = screen.getByText("#italia").closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(true);
    });

    it("query rows cascade greyed when network is parked", () => {
      mockNetworkConnectionState = { freenode: "parked" };
      render(() => <Sidebar />);
      const li = screen.getByText("alice").closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(true);
    });

    it("does NOT cascade greyed when network is connected (existing per-channel rule still applies)", () => {
      mockNetworkConnectionState = { freenode: "connected" };
      mockWindowState = { "freenode #italia": "failed" };
      render(() => <Sidebar />);
      // #italia (per-channel failed) stays greyed via the existing rule.
      const liFailed = screen.getByText("#italia").closest("li");
      expect(
        liFailed?.querySelector(".sidebar-window-btn")?.classList.contains("sidebar-window-greyed"),
      ).toBe(true);
      // #azzurra (joined per channelsBySlug, no windowState entry) stays
      // ungreyed — proves the network derivation isn't fired when state
      // is connected.
      const liJoined = screen.getByText("#azzurra").closest("li");
      expect(
        liJoined?.querySelector(".sidebar-window-btn")?.classList.contains("sidebar-window-greyed"),
      ).toBe(false);
    });

    it("network header tooltip carries the connection_state_reason when parked", () => {
      mockNetworkConnectionState = { freenode: "parked" };
      mockNetworkConnectionReason = { freenode: "testing parked state" };
      render(() => <Sidebar />);
      const h3 = screen.getByText("freenode");
      expect(h3.getAttribute("title")).toBe("testing parked state");
    });

    it("network header tooltip is absent when connected (no reason to show)", () => {
      mockNetworkConnectionState = { freenode: "connected" };
      mockNetworkConnectionReason = { freenode: "should not appear" };
      render(() => <Sidebar />);
      const h3 = screen.getByText("freenode");
      expect(h3.getAttribute("title")).toBeNull();
    });
  });

  // CP15 B6 — synthetic sidebar rows for state ∈ {pending, failed,
  // kicked, parked} when the channel is NOT in channelsBySlug. The
  // intent doc (Window state machine §) calls for "Sidebar entry
  // greyed/dim" on every
  // failed/kicked/parked window — same projection as pending. Without
  // synthetic rendering for the failed family, a /join attempt against
  // an invite-only / banned / keyed channel would leave the operator
  // with no sidebar entry at all (channelsBySlug never receives the
  // channel since the JOIN was rejected; the pending row vanishes when
  // state flips to failed). Source-of-truth rule: cic projects a
  // synthetic row whenever windowState carries a key that channelsBySlug
  // doesn't — one mental model, all four non-joined states.
  describe("CP15 B6 — synthetic sidebar rows for failed/kicked/parked", () => {
    it("renders a synthetic row for a channel in state=failed NOT yet in channelsBySlug", () => {
      mockWindowState = { "freenode #invite-only": "failed" };
      render(() => <Sidebar />);
      const row = screen.getByText("#invite-only");
      expect(row).toBeInTheDocument();
      // Greyed since state ∈ {failed, kicked, parked}.
      const li = row.closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(true);
    });

    it("renders a synthetic row for a channel in state=kicked NOT yet in channelsBySlug", () => {
      mockWindowState = { "freenode #banned": "kicked" };
      render(() => <Sidebar />);
      const row = screen.getByText("#banned");
      expect(row).toBeInTheDocument();
      const li = row.closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(true);
    });

    it("renders a synthetic row for a channel in state=parked NOT yet in channelsBySlug", () => {
      mockWindowState = { "freenode #disconnected": "parked" };
      render(() => <Sidebar />);
      const row = screen.getByText("#disconnected");
      expect(row).toBeInTheDocument();
      const li = row.closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(true);
    });

    it("does NOT duplicate a synthetic failed row when channelsBySlug already carries the channel", () => {
      // Mirror of the pending dedup gate — channelsBySlug branch wins
      // when both projections would render the same name.
      mockWindowState = { "freenode #italia": "failed" };
      render(() => <Sidebar />);
      const matches = screen.getAllByText("#italia");
      expect(matches.length).toBe(1);
    });
  });

  // UX-5 bucket BK (2026-05-19) — pseudo-rows are closeable via ×.
  // Pre-BK the pseudo-row was uncloseable + the same window also showed
  // in archive (one window, two surfaces — vjt dogfood bug).
  // Post-BK: × fires setParted (drops windowStateByChannel key) →
  // row vanishes; visibleArchiveForNetwork's pseudo-name filter releases
  // and the archive section shows the row. If the closed pseudo-row WAS
  // the selected window, selection redirects to $server.
  describe("UX-5 bucket BK — pseudo-row × button", () => {
    it("renders an aria-labeled × button on a failed pseudo-row", () => {
      mockWindowState = { "freenode #it-opers": "failed" };
      render(() => <Sidebar />);
      const closeBtn = screen.getByLabelText("Close #it-opers");
      expect(closeBtn).toBeInTheDocument();
    });

    it("renders an aria-labeled × button on a kicked pseudo-row", () => {
      mockWindowState = { "freenode #kicked-from": "kicked" };
      render(() => <Sidebar />);
      const closeBtn = screen.getByLabelText("Close #kicked-from");
      expect(closeBtn).toBeInTheDocument();
    });

    it("renders an aria-labeled × button on a pending pseudo-row (operator can cancel)", () => {
      mockWindowState = { "freenode #new-room": "pending" };
      render(() => <Sidebar />);
      const closeBtn = screen.getByLabelText("Close #new-room");
      expect(closeBtn).toBeInTheDocument();
    });

    it("clicking × on a failed pseudo-row calls setParted with the channelKey", () => {
      mockWindowState = { "freenode #it-opers": "failed" };
      render(() => <Sidebar />);
      const closeBtn = screen.getByLabelText("Close #it-opers");
      fireEvent.click(closeBtn);
      expect(setPartedMock).toHaveBeenCalledWith("freenode #it-opers");
    });

    it("clicking × on the selected pseudo-row redirects selection to $server", () => {
      mockWindowState = { "freenode #it-opers": "failed" };
      vi.spyOn(selMod, "selectedChannel").mockReturnValue({
        networkSlug: "freenode",
        channelName: "#it-opers",
        kind: "channel",
      });
      render(() => <Sidebar />);
      const closeBtn = screen.getByLabelText("Close #it-opers");
      fireEvent.click(closeBtn);
      expect(selMod.setSelectedChannel).toHaveBeenCalledWith({
        networkSlug: "freenode",
        channelName: "$server",
        kind: "server",
      });
      expect(setPartedMock).toHaveBeenCalledWith("freenode #it-opers");
    });

    it("clicking × on a non-selected pseudo-row does NOT redirect selection", () => {
      mockWindowState = { "freenode #it-opers": "failed" };
      // Default selectedChannel mock returns null. Re-mock to a DIFFERENT
      // selection so we can assert setSelectedChannel is NOT called.
      vi.spyOn(selMod, "selectedChannel").mockReturnValue({
        networkSlug: "freenode",
        channelName: "#italia",
        kind: "channel",
      });
      render(() => <Sidebar />);
      const closeBtn = screen.getByLabelText("Close #it-opers");
      fireEvent.click(closeBtn);
      expect(selMod.setSelectedChannel).not.toHaveBeenCalled();
      expect(setPartedMock).toHaveBeenCalledWith("freenode #it-opers");
    });
  });

  // CP15 B5 — archive list filters live (joined channel OR open query)
  // entries. UX-2 (2026-05-17) lifted the filter into
  // `lib/archive.ts` `visibleArchiveForNetwork/2` so BottomBar's chip +
  // ArchiveModal share it. Coverage moved to `archive.test.ts`.

  // UX-4 bucket C — collapsed network+server window with `⚙️ <slug>`
  // prefix. The per-network `<h3>` header is gone; the first `<li>` IS
  // both the network grouping label AND the server-window selector.
  //
  // UX-5 BH (2026-05-19): the legacy `<section class="sidebar-network">`
  // wrapper was killed; the per-network `<ul>` carries
  // `.sidebar-network-section` directly. The `<h3>`-NOT-present
  // assertion still holds (UX-4 C dropped it); selector updated.
  describe("UX-4 bucket C — collapsed network header row", () => {
    it("renders NO <h3> per network section (header collapsed into row)", () => {
      const { container } = render(() => <Sidebar />);
      expect(container.querySelector(".sidebar-network-section h3")).toBeNull();
    });

    it("renders the network header row with .sidebar-network-header class + slug", () => {
      const { container } = render(() => <Sidebar />);
      const headers = container.querySelectorAll("li.sidebar-network-header");
      expect(headers.length).toBe(1);
      expect(headers[0]?.textContent).toContain("freenode");
    });

    it("network header row renders the ⚙️ emoji prefix", () => {
      const { container } = render(() => <Sidebar />);
      const emoji = container.querySelector("li.sidebar-network-header .sidebar-network-emoji");
      expect(emoji?.textContent).toBe("⚙️");
    });

    it("clicking the network header row selects the server window", () => {
      const { container } = render(() => <Sidebar />);
      const headerBtn = container.querySelector(
        "li.sidebar-network-header .sidebar-window-btn",
      ) as HTMLElement | null;
      expect(headerBtn).not.toBeNull();
      fireEvent.click(headerBtn as HTMLElement);
      expect(selMod.setSelectedChannel).toHaveBeenCalledWith({
        networkSlug: "freenode",
        channelName: "$server",
        kind: "server",
      });
    });

    // #276 — the away indicator's VISIBLE label is the 💤 (zzz) emoji, not
    // the word "away". The accessible name stays the WORD "away"
    // (aria-label) so screen readers announce the state, not "sleeping
    // symbol". Driven by the same `away_confirmed` server event.
    it("💤 away badge surfaces on the collapsed network header row (#276)", () => {
      mockAwayByNetwork = { freenode: true };
      const { container } = render(() => <Sidebar />);
      const header = container.querySelector("li.sidebar-network-header");
      const badge = header?.querySelector(".sidebar-away-badge");
      expect(badge?.textContent).toBe("💤");
    });

    it("away badge keeps the accessible name 'away' for a11y (#276)", () => {
      mockAwayByNetwork = { freenode: true };
      const { container } = render(() => <Sidebar />);
      const header = container.querySelector("li.sidebar-network-header");
      const badge = header?.querySelector(".sidebar-away-badge");
      expect(badge?.getAttribute("aria-label")).toBe("away");
    });

    it("away badge is absent when the network is not away", () => {
      mockAwayByNetwork = {};
      const { container } = render(() => <Sidebar />);
      const header = container.querySelector("li.sidebar-network-header");
      expect(header?.querySelector(".sidebar-away-badge")).toBeNull();
    });

    it("channel rows still render as siblings inside the same <ul> as the header", () => {
      const { container } = render(() => <Sidebar />);
      // UX-5 BH: the per-network `<ul>` now carries `.sidebar-network-section`
      // directly (no wrapping `<section>` — that was killed in BH).
      const ul = container.querySelector("ul.sidebar-network-section");
      const headerLi = ul?.querySelector("li.sidebar-network-header");
      const italiaLi = screen.getByText("#italia").closest("li");
      expect(headerLi).not.toBeNull();
      expect(italiaLi?.parentElement).toBe(ul);
      expect(headerLi?.parentElement).toBe(ul);
    });
  });

  // UX-4 bucket D — server-window × button on the collapsed header row.
  // Click routes to lib/windowClose.disconnectNetwork which branches on
  // subject kind (visitor → quitAll, registered → patchNetwork(parked)).
  describe("UX-4 bucket D — server-window × button", () => {
    it("renders a close × button on the network-header row", () => {
      const { container } = render(() => <Sidebar />);
      const header = container.querySelector("li.sidebar-network-header");
      const closeBtn = header?.querySelector(".sidebar-close");
      expect(closeBtn).not.toBeNull();
      expect(closeBtn?.textContent).toBe("×");
      expect(closeBtn?.getAttribute("aria-label")).toBe("Disconnect freenode");
    });

    // #195 — clicking × opens the disconnect-confirm modal; the park
    // (patchNetwork) fires only on affirmative confirm, never on the bare
    // click.
    it("clicking × on the header row opens a disconnect-confirm modal; confirming calls patchNetwork(:parked) (#195)", async () => {
      mockSubject = { kind: "user", id: "u-1", name: "alice" };
      const apiMod2 = await import("../lib/api");
      dismissConfirm();
      const { container } = render(() => <Sidebar />);
      const header = container.querySelector("li.sidebar-network-header");
      const closeBtn = header?.querySelector(".sidebar-close") as HTMLElement;
      fireEvent.click(closeBtn);
      expect(confirmRequest()?.body).toBe("Disconnect from freenode?");
      expect(apiMod2.patchNetwork).not.toHaveBeenCalled();
      acceptConfirm();
      await Promise.resolve();
      expect(apiMod2.patchNetwork).toHaveBeenCalledWith("tok", "freenode", {
        connection_state: "parked",
      });
    });
  });

  // UX-4 bucket N — admin sidebar row. Identity-scoped, admin-only,
  // pinned between Home and the first network's server row. Visibility
  // gated on `isAdmin()` from `lib/networks.ts` (single source of truth
  // shared with Shell.tsx pane dispatcher + SettingsDrawer.tsx drawer
  // entry). Click sets selection to the `$admin` pseudo-window kind.
  describe("UX-4 bucket N — admin sidebar row", () => {
    it("admin user: renders the admin row between Home and the first network", () => {
      adminHolder.value = true;
      const { container } = render(() => <Sidebar />);
      const adminRow = container.querySelector('[data-testid="sidebar-admin-row"]');
      expect(adminRow).not.toBeNull();
      // Row label literally reads "admin".
      expect(adminRow?.textContent).toContain("admin");
      // Row glyph is the wrench (🔧) — verified via the dedicated
      // emoji span so a stray "admin" appearance elsewhere doesn't
      // false-positive.
      const emoji = adminRow?.querySelector(".sidebar-admin-emoji");
      expect(emoji?.textContent).toBe("🔧");
    });

    it("non-admin user: does NOT render the admin row", () => {
      adminHolder.value = false;
      const { container } = render(() => <Sidebar />);
      expect(container.querySelector('[data-testid="sidebar-admin-row"]')).toBeNull();
      expect(container.querySelector(".sidebar-admin-section")).toBeNull();
    });

    it("clicking the admin row sets selection to the $admin window", () => {
      adminHolder.value = true;
      const { container } = render(() => <Sidebar />);
      const row = container.querySelector(
        '[data-testid="sidebar-admin-row"]',
      ) as HTMLElement | null;
      expect(row).not.toBeNull();
      fireEvent.click(row as HTMLElement);
      expect(selMod.setSelectedChannel).toHaveBeenCalledWith({
        networkSlug: "$admin",
        channelName: "$admin",
        kind: "admin",
      });
    });
  });

  // UX-5 bucket B — home sidebar row 🏠 emoji icon. Visual parity with
  // the bucket-C network ⚙️ + bucket-N admin 🔧 treatment so the three
  // identity-scoped row kinds (home, admin, per-network header) read as
  // a uniform "iconed row" group. Pre-bucket the home row rendered text
  // only — the visual outlier.
  describe("UX-5 bucket B — home row emoji icon", () => {
    it("home row renders the 🏠 emoji prefix", () => {
      const { container } = render(() => <Sidebar />);
      const emoji = container.querySelector(".sidebar-home-section .sidebar-home-emoji");
      expect(emoji?.textContent?.trim()).toBe("🏠");
    });
  });

  // #84 — per-network channel directory row. Renders unconditionally
  // between the ⚙️ server row and the channel list. Click selects the
  // `$list` pseudo-window (kind "list"); no scrollback fetch because
  // kindHasScrollback("list") = false.
  describe("#84 — channel directory 📇 row", () => {
    it("renders a 📇 channels row for each network", () => {
      const { container } = render(() => <Sidebar />);
      const listLi = container.querySelector(`[data-window-name="${LIST_WINDOW_NAME}"]`);
      expect(listLi).not.toBeNull();
      expect(listLi?.textContent).toContain("channels");
      const emoji = listLi?.querySelector(".sidebar-network-emoji");
      expect(emoji?.textContent?.trim()).toBe("📇");
    });

    it("clicking the 📇 channels row selects the $list window (kind list)", () => {
      const { container } = render(() => <Sidebar />);
      const listLi = container.querySelector(`[data-window-name="${LIST_WINDOW_NAME}"]`);
      const btn = listLi?.querySelector("button") as HTMLElement | null;
      expect(btn).not.toBeNull();
      fireEvent.click(btn as HTMLElement);
      expect(selMod.setSelectedChannel).toHaveBeenCalledWith({
        networkSlug: "freenode",
        channelName: LIST_WINDOW_NAME,
        kind: "list",
      });
    });
  });
});
