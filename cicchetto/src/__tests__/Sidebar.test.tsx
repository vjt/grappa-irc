import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockNetworkConnectionState: Record<string, string | undefined> = {};
let mockNetworkConnectionReason: Record<string, string | null | undefined> = {};
// UX-4 bucket N — mutable holder so individual tests can flip the
// admin gate on/off. `isAdmin()` in Sidebar drives the new admin row
// visibility; default false to keep pre-N tests unchanged.
const adminHolder = vi.hoisted(() => ({ value: false }));

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
  unreadCounts: () => ({ "freenode #bnc": 3 }),
  messagesUnread: () => ({ "freenode #bnc": 3, "freenode $server": 7 }),
  eventsUnread: () => ({ "freenode $server": 2 }),
}));

vi.mock("../lib/mentions", () => ({
  mentionCounts: () => ({ "freenode #italia": 2, "freenode $server": 1 }),
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

vi.mock("../lib/windowState", () => ({
  windowStateByChannel: () => mockWindowState,
}));

import * as apiMod from "../lib/api";
import * as archiveMod from "../lib/archive";
// Capture mocked module references at import time, before any resetModules
import * as qwMod from "../lib/queryWindows";
import * as selMod from "../lib/selection";
import Sidebar from "../Sidebar";

beforeEach(() => {
  vi.clearAllMocks();
  mockWindowState = {};
  mockNetworkConnectionState = {};
  mockNetworkConnectionReason = {};
  mockAwayByNetwork = {};
  adminHolder.value = false;
});

describe("Sidebar", () => {
  it("renders all channels grouped by network", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    expect(screen.getByText("#italia")).toBeInTheDocument();
    expect(screen.getByText("#azzurra")).toBeInTheDocument();
    expect(screen.getByText("#bnc")).toBeInTheDocument();
    expect(screen.getByText("freenode")).toBeInTheDocument();
  });

  it("parted channels (joined: false) get the .parted class", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    const parted = screen.getByText("#azzurra");
    expect(parted.classList.contains("parted")).toBe(true);
  });

  it("joined channels do NOT get the .parted class", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    const joined = screen.getByText("#italia");
    expect(joined.classList.contains("parted")).toBe(false);
  });

  it("renders unread count for channels with messages while away", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    // Scope to the #bnc <li> — the Server <li> also has a msg-unread badge
    // since CP13 (S8). The test asserts the channel-side badge specifically.
    const bncLi = screen.getByText("#bnc").closest("li");
    const unread = bncLi?.querySelector(".sidebar-msg-unread");
    expect(unread?.textContent).toBe("3");
  });

  it("renders mention badge with @-prefix for channels with mentions", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
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
    render(() => <Sidebar onSelect={vi.fn()} />);
    const serverLi = screen.getByText("freenode").closest("li.sidebar-network-header");
    expect(serverLi).not.toBeNull();
    const msg = serverLi?.querySelector(".sidebar-msg-unread");
    const events = serverLi?.querySelector(".sidebar-events-unread");
    const mention = serverLi?.querySelector(".sidebar-mention");
    expect(msg?.textContent).toBe("7");
    expect(events?.textContent).toBe("2");
    expect(mention?.textContent).toBe("@1");
  });

  it("clicking a channel calls setSelectedChannel + onSelect", async () => {
    const sel = await import("../lib/selection");
    const onSelect = vi.fn();
    render(() => <Sidebar onSelect={onSelect} />);
    fireEvent.click(screen.getByText("#italia"));
    expect(sel.setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channelName: "#italia",
      kind: "channel",
    });
    expect(onSelect).toHaveBeenCalled();
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
      unreadCounts: () => ({}),
      messagesUnread: () => ({}),
      eventsUnread: () => ({}),
    }));
    vi.doMock("../lib/mentions", () => ({ mentionCounts: () => ({}) }));
    vi.doMock("../lib/queryWindows", () => ({
      queryWindowsByNetwork: () => ({}),
      closeQueryWindowState: vi.fn(),
      openQueryWindowState: vi.fn(),
      setQueryWindowsByNetwork: vi.fn(),
    }));
    const { default: SidebarFresh } = await import("../Sidebar");
    render(() => <SidebarFresh onSelect={vi.fn()} />);
    expect(screen.getByText(/no networks/i)).toBeInTheDocument();
  });

  // C1.2: Query windows appear in sidebar
  it("renders query windows (alice, bob) for the network", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
  });

  // UX-4 bucket D — the network-header row (formerly the standalone
  // server-row) IS closeable. Click dispatches `disconnectNetwork`
  // which routes to /quit for visitors and PATCH :parked for users.
  // Selection auto-redirects to home via selection.ts effect.
  it("server window has a close button (UX-4 bucket D)", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    const li = screen.getByText("freenode").closest("li.sidebar-network-header");
    expect(li?.querySelector(".sidebar-close")).not.toBeNull();
  });

  // C1.2: Channel windows have a close button
  it("channel windows have a close button", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    const channelEntry = screen.getByText("#italia");
    const li = channelEntry.closest("li");
    expect(li?.querySelector(".sidebar-close")).toBeTruthy();
  });

  // C1.2: Query windows have a close button
  it("query windows have a close button", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    const queryEntry = screen.getByText("alice");
    const li = queryEntry.closest("li");
    expect(li?.querySelector(".sidebar-close")).toBeTruthy();
  });

  // C1.2: Clicking X on a query window calls closeQueryWindowState
  it("clicking close on query window calls closeQueryWindowState", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    const aliceEntry = screen.getByText("alice");
    const li = aliceEntry.closest("li");
    const closeBtn = li?.querySelector(".sidebar-close") as HTMLElement;
    fireEvent.click(closeBtn);
    expect(qwMod.closeQueryWindowState).toHaveBeenCalledWith(1, "alice");
  });

  // C1.2: Clicking X on a channel calls postPart
  it("clicking close on channel calls postPart", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    const italiaEntry = screen.getByText("#italia");
    const li = italiaEntry.closest("li");
    const closeBtn = li?.querySelector(".sidebar-close") as HTMLElement;
    fireEvent.click(closeBtn);
    expect(apiMod.postPart).toHaveBeenCalledWith("tok", "freenode", "#italia");
  });

  // CP15 B4 — Archive section per network. Collapsed by default
  // (`<details>` without `open`), lazy-loaded on first expand
  // (`loadArchive(slug)`), entries clickable → setSelectedChannel.
  describe("Archive section", () => {
    it("renders Archive <details> per network, collapsed by default", () => {
      render(() => <Sidebar onSelect={vi.fn()} />);
      const archive = screen.getByText("Archive");
      const details = archive.closest("details") as HTMLDetailsElement | null;
      expect(details).toBeTruthy();
      expect(details?.open).toBe(false);
    });

    it("renders one button per archived entry inside the network section", () => {
      render(() => <Sidebar onSelect={vi.fn()} />);
      // Both entries are rendered eagerly (the renderer reads from
      // `archivedBySlug()` which the test mock pre-populates). Lazy
      // FETCH still happens on expand; the renderer doesn't wait.
      expect(screen.getByText("#sniffo")).toBeInTheDocument();
      expect(screen.getByText("vjt-peer")).toBeInTheDocument();
    });

    it("expanding the Archive <details> calls loadArchive(slug)", () => {
      render(() => <Sidebar onSelect={vi.fn()} />);
      const archive = screen.getByText("Archive");
      const details = archive.closest("details") as HTMLDetailsElement;
      details.open = true;
      // Solid handlers fire on the toggle event, not on the property set.
      details.dispatchEvent(new Event("toggle"));
      expect(archiveMod.loadArchive).toHaveBeenCalledWith("freenode");
    });

    it("clicking an archived channel entry sets selection with kind=channel", () => {
      render(() => <Sidebar onSelect={vi.fn()} />);
      fireEvent.click(screen.getByText("#sniffo"));
      expect(selMod.setSelectedChannel).toHaveBeenCalledWith({
        networkSlug: "freenode",
        channelName: "#sniffo",
        kind: "channel",
      });
    });

    it("clicking an archived query entry sets selection with kind=query", () => {
      render(() => <Sidebar onSelect={vi.fn()} />);
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
      render(() => <Sidebar onSelect={vi.fn()} />);
      const li = screen.getByText("#italia").closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(true);
    });

    it("channel rows get .sidebar-window-greyed when state=kicked", () => {
      mockWindowState = { "freenode #italia": "kicked" };
      render(() => <Sidebar onSelect={vi.fn()} />);
      const li = screen.getByText("#italia").closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(true);
    });

    it("channel rows get .sidebar-window-greyed when state=parked", () => {
      mockWindowState = { "freenode #italia": "parked" };
      render(() => <Sidebar onSelect={vi.fn()} />);
      const li = screen.getByText("#italia").closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(true);
    });

    it("channel rows do NOT get .sidebar-window-greyed when state=joined", () => {
      mockWindowState = { "freenode #italia": "joined" };
      render(() => <Sidebar onSelect={vi.fn()} />);
      const li = screen.getByText("#italia").closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(false);
    });

    it("channel rows do NOT get .sidebar-window-greyed when no state entry", () => {
      mockWindowState = {};
      render(() => <Sidebar onSelect={vi.fn()} />);
      const li = screen.getByText("#italia").closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(false);
    });

    it("query rows get .sidebar-window-greyed when state=failed (DM target gone)", () => {
      // DMs don't transition to failed in the IRC sense, but the state
      // map shape is the same — apply uniformly so future state kinds
      // ride the same render branch without per-kind plumbing.
      mockWindowState = { "freenode alice": "kicked" };
      render(() => <Sidebar onSelect={vi.fn()} />);
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
      render(() => <Sidebar onSelect={vi.fn()} />);
      expect(screen.getByText("#new-room")).toBeInTheDocument();
    });

    it("does NOT duplicate a pending row when the channel IS already in channelsBySlug", () => {
      // #italia is in channelsBySlug + state=pending. The row should
      // appear EXACTLY ONCE — channelsBySlug branch wins; the synthetic
      // pending row only fires when channelsBySlug doesn't already
      // carry the channel.
      mockWindowState = { "freenode #italia": "pending" };
      render(() => <Sidebar onSelect={vi.fn()} />);
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
  describe("CP19 T32 — per-network parked/failed derivation overlay", () => {
    it("network header gets .sidebar-network-greyed when connection_state=parked", () => {
      mockNetworkConnectionState = { freenode: "parked" };
      render(() => <Sidebar onSelect={vi.fn()} />);
      const header = screen.getByText("freenode").closest("section");
      expect(header?.classList.contains("sidebar-network-greyed")).toBe(true);
    });

    it("network header gets .sidebar-network-greyed when connection_state=failed", () => {
      mockNetworkConnectionState = { freenode: "failed" };
      render(() => <Sidebar onSelect={vi.fn()} />);
      const header = screen.getByText("freenode").closest("section");
      expect(header?.classList.contains("sidebar-network-greyed")).toBe(true);
    });

    it("network header does NOT get .sidebar-network-greyed when connection_state=connected", () => {
      mockNetworkConnectionState = { freenode: "connected" };
      render(() => <Sidebar onSelect={vi.fn()} />);
      const header = screen.getByText("freenode").closest("section");
      expect(header?.classList.contains("sidebar-network-greyed")).toBe(false);
    });

    it("channel rows cascade greyed when network is parked, even if window state is joined", () => {
      // Critical derivation rule: stale `windowStateByChannel` entries
      // (which retain the pre-park values until the GenServer is dead +
      // a reconnect re-emits) MUST NOT win over the network-level park.
      // If they did, /disconnect would leave channels visually live.
      mockNetworkConnectionState = { freenode: "parked" };
      mockWindowState = { "freenode #italia": "joined" };
      render(() => <Sidebar onSelect={vi.fn()} />);
      const li = screen.getByText("#italia").closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(true);
    });

    it("channel rows cascade greyed when network is failed, even with no window state entry", () => {
      mockNetworkConnectionState = { freenode: "failed" };
      mockWindowState = {};
      render(() => <Sidebar onSelect={vi.fn()} />);
      const li = screen.getByText("#italia").closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(true);
    });

    it("query rows cascade greyed when network is parked", () => {
      mockNetworkConnectionState = { freenode: "parked" };
      render(() => <Sidebar onSelect={vi.fn()} />);
      const li = screen.getByText("alice").closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(true);
    });

    it("does NOT cascade greyed when network is connected (existing per-channel rule still applies)", () => {
      mockNetworkConnectionState = { freenode: "connected" };
      mockWindowState = { "freenode #italia": "failed" };
      render(() => <Sidebar onSelect={vi.fn()} />);
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
      render(() => <Sidebar onSelect={vi.fn()} />);
      const h3 = screen.getByText("freenode");
      expect(h3.getAttribute("title")).toBe("testing parked state");
    });

    it("network header tooltip is absent when connected (no reason to show)", () => {
      mockNetworkConnectionState = { freenode: "connected" };
      mockNetworkConnectionReason = { freenode: "should not appear" };
      render(() => <Sidebar onSelect={vi.fn()} />);
      const h3 = screen.getByText("freenode");
      expect(h3.getAttribute("title")).toBeNull();
    });
  });

  // CP15 B6 — synthetic sidebar rows for state ∈ {pending, failed,
  // kicked, parked} when the channel is NOT in channelsBySlug. The
  // intent doc (docs/plans/2026-05-07-event-driven-windows.md, Window
  // state machine §) calls for "Sidebar entry greyed/dim" on every
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
      render(() => <Sidebar onSelect={vi.fn()} />);
      const row = screen.getByText("#invite-only");
      expect(row).toBeInTheDocument();
      // Greyed since state ∈ {failed, kicked, parked}.
      const li = row.closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(true);
    });

    it("renders a synthetic row for a channel in state=kicked NOT yet in channelsBySlug", () => {
      mockWindowState = { "freenode #banned": "kicked" };
      render(() => <Sidebar onSelect={vi.fn()} />);
      const row = screen.getByText("#banned");
      expect(row).toBeInTheDocument();
      const li = row.closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(true);
    });

    it("renders a synthetic row for a channel in state=parked NOT yet in channelsBySlug", () => {
      mockWindowState = { "freenode #disconnected": "parked" };
      render(() => <Sidebar onSelect={vi.fn()} />);
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
      render(() => <Sidebar onSelect={vi.fn()} />);
      const matches = screen.getAllByText("#italia");
      expect(matches.length).toBe(1);
    });
  });

  // CP15 B5 — archive list filters live (joined channel OR open query)
  // entries. UX-2 (2026-05-17) lifted the filter into
  // `lib/archive.ts` `visibleArchiveForNetwork/2` so BottomBar's chip +
  // ArchiveModal share it. Coverage moved to `archive.test.ts`.

  // UX-4 bucket C — collapsed network+server window with `⚙️ <slug>`
  // prefix. The per-network `<h3>` header is gone; the first `<li>` IS
  // both the network grouping label AND the server-window selector.
  describe("UX-4 bucket C — collapsed network header row", () => {
    it("renders NO <h3> per network section (header collapsed into row)", () => {
      const { container } = render(() => <Sidebar onSelect={vi.fn()} />);
      expect(container.querySelector(".sidebar-network h3")).toBeNull();
    });

    it("renders the network header row with .sidebar-network-header class + slug", () => {
      const { container } = render(() => <Sidebar onSelect={vi.fn()} />);
      const headers = container.querySelectorAll("li.sidebar-network-header");
      expect(headers.length).toBe(1);
      expect(headers[0]?.textContent).toContain("freenode");
    });

    it("network header row renders the ⚙️ emoji prefix", () => {
      const { container } = render(() => <Sidebar onSelect={vi.fn()} />);
      const emoji = container.querySelector("li.sidebar-network-header .sidebar-network-emoji");
      expect(emoji?.textContent).toBe("⚙️");
    });

    it("clicking the network header row selects the server window", () => {
      const { container } = render(() => <Sidebar onSelect={vi.fn()} />);
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

    it("[away] badge surfaces on the collapsed network header row", () => {
      mockAwayByNetwork = { freenode: true };
      const { container } = render(() => <Sidebar onSelect={vi.fn()} />);
      const header = container.querySelector("li.sidebar-network-header");
      const badge = header?.querySelector(".sidebar-away-badge");
      expect(badge?.textContent).toBe("[away]");
    });

    it("[away] badge is absent when the network is not away", () => {
      mockAwayByNetwork = {};
      const { container } = render(() => <Sidebar onSelect={vi.fn()} />);
      const header = container.querySelector("li.sidebar-network-header");
      expect(header?.querySelector(".sidebar-away-badge")).toBeNull();
    });

    it("channel rows still render as siblings inside the same <ul> as the header", () => {
      const { container } = render(() => <Sidebar onSelect={vi.fn()} />);
      const ul = container.querySelector(".sidebar-network ul");
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
      const { container } = render(() => <Sidebar onSelect={vi.fn()} />);
      const header = container.querySelector("li.sidebar-network-header");
      const closeBtn = header?.querySelector(".sidebar-close");
      expect(closeBtn).not.toBeNull();
      expect(closeBtn?.textContent).toBe("×");
      expect(closeBtn?.getAttribute("aria-label")).toBe("Disconnect freenode");
    });

    it("clicking × on the header row triggers patchNetwork(:parked) for registered users", async () => {
      mockSubject = { kind: "user", id: "u-1", name: "alice" };
      const apiMod2 = await import("../lib/api");
      const { container } = render(() => <Sidebar onSelect={vi.fn()} />);
      const header = container.querySelector("li.sidebar-network-header");
      const closeBtn = header?.querySelector(".sidebar-close") as HTMLElement;
      fireEvent.click(closeBtn);
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
      const { container } = render(() => <Sidebar onSelect={vi.fn()} />);
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
      const { container } = render(() => <Sidebar onSelect={vi.fn()} />);
      expect(container.querySelector('[data-testid="sidebar-admin-row"]')).toBeNull();
      expect(container.querySelector(".sidebar-admin-section")).toBeNull();
    });

    it("clicking the admin row sets selection to the $admin window", () => {
      adminHolder.value = true;
      const { container } = render(() => <Sidebar onSelect={vi.fn()} />);
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
});
