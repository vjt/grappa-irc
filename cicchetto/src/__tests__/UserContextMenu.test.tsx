import { render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pressAndClick } from "./helpers/pointerEvents";

// C5.1 — UserContextMenu: right-click submenu on member nick.
//
// Tests assert:
//   1. All 11 items render (op/deop/voice/devoice/kick/ban nick/ban host/
//      kickban/WHOIS/CTCP/query — issue 2346 replaced the bare "ban").
//   2. When own nick has @-mode, op-gated items are enabled.
//   3. When own nick lacks @-mode, op-gated items are disabled (not hidden).
//   4. WHOIS + Query are always enabled regardless of modes.
//   5. Clicking an enabled item fires the correct socket push.
//   6. Clicking outside fires onClose.
//   7. Pressing Escape fires onClose.

const mockPushChannelOp = vi.fn();
const mockPushChannelDeop = vi.fn();
const mockPushChannelVoice = vi.fn();
const mockPushChannelDevoice = vi.fn();
const mockPushChannelKick = vi.fn();
const mockPushChannelBan = vi.fn();
const mockPushWhois = vi.fn();
const mockResolveUserhost = vi.fn();
const mockOpenQueryWindowState = vi.fn();
const mockSetSelectedChannel = vi.fn();
const mockSendCtcpQuery = vi.fn();

vi.mock("../lib/socket", () => ({
  pushChannelOp: (...args: unknown[]) => mockPushChannelOp(...args),
  pushChannelDeop: (...args: unknown[]) => mockPushChannelDeop(...args),
  pushChannelVoice: (...args: unknown[]) => mockPushChannelVoice(...args),
  pushChannelDevoice: (...args: unknown[]) => mockPushChannelDevoice(...args),
  pushChannelKick: (...args: unknown[]) => mockPushChannelKick(...args),
  pushChannelBan: (...args: unknown[]) => mockPushChannelBan(...args),
  pushWhois: (...args: unknown[]) => mockPushWhois(...args),
  resolveUserhost: (...args: unknown[]) => mockResolveUserhost(...args),
}));

// #1192 — the CTCP submenu dispatches through the shared seam; its own
// contract (the #640 source-window echo, the #600 ordering) is pinned in
// ctcpQuery.test.ts, so here it is a boundary spy. Resolves, because the
// production action attaches a `.catch` and an unhandled rejection from a
// bare `vi.fn()` would fail the run for the wrong reason.
vi.mock("../lib/ctcpQuery", () => ({
  sendCtcpQuery: (...args: unknown[]) => mockSendCtcpQuery(...args),
}));

vi.mock("../lib/networks", () => ({
  // #1861 — casemappingForSlug (lib/casemapping.ts) resolves the fold
  // through this map, so the mock has to carry it.
  networkIdBySlug: () => undefined,
  networks: vi.fn(() => [{ id: 42, slug: "freenode", inserted_at: "x", updated_at: "y" }]),
}));

vi.mock("../lib/queryWindows", () => ({
  openQueryWindowState: (...args: unknown[]) => mockOpenQueryWindowState(...args),
  queryWindowsByNetwork: vi.fn(() => ({})),
  canonicalQueryNick: (_networkId: number, nick: string) => nick,
}));

vi.mock("../lib/selection", () => ({
  setSelectedChannel: (...args: unknown[]) => mockSetSelectedChannel(...args),
  selectedChannel: vi.fn(() => null),
  applySeedEnvelope: vi.fn(),
}));

// We also need to mock pushWhois — UserContextMenu uses pushWhois from socket.ts.
// The mock above covers it.

import { channelKey } from "../lib/channelKey";
import { seedFromTest } from "../lib/members";
import {
  __resetForTest,
  overlayEscapeDepth,
  runTopmostOverlayEscape,
} from "../lib/overlayScrollLock";
import UserContextMenu from "../UserContextMenu";

const flush = () => new Promise((r) => setTimeout(r, 0));

const baseProps = {
  networkSlug: "freenode",
  networkId: 42,
  channelName: "#grappa",
  targetNick: "alice",
  targetHost: null as string | null,
  ownModes: [] as string[],
  position: { x: 100, y: 200 },
  onClose: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSendCtcpQuery.mockResolvedValue(undefined);
  for (const m of [
    mockPushChannelOp,
    mockPushChannelDeop,
    mockPushChannelVoice,
    mockPushChannelDevoice,
    mockPushChannelKick,
    mockPushChannelBan,
  ]) {
    m.mockResolvedValue(undefined);
  }
  seedFromTest(channelKey("freenode", "#grappa"), [{ nick: "alice", modes: [] }]);
  __resetForTest();
});

describe("UserContextMenu", () => {
  describe("renders all 11 items", () => {
    it("shows Op, Deop, Voice, Devoice, Kick, Ban nick, Ban host, Kickban, WHOIS, CTCP, Query", () => {
      render(() => <UserContextMenu {...baseProps} />);
      expect(screen.getByRole("button", { name: /^op$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^deop$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^voice$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^devoice$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^kick$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^ban nick$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^ban host$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^kickban$/i })).toBeInTheDocument();
      // issue 2346 — the ambiguous bare "Ban" is gone.
      expect(screen.queryByRole("button", { name: /^ban$/i })).toBeNull();
      expect(screen.getByRole("button", { name: /^whois$/i })).toBeInTheDocument();
      // #1192 — the shell appends the ▸, so the accessible name carries it.
      expect(screen.getByRole("button", { name: /^ctcp ▸$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^query$/i })).toBeInTheDocument();
    });
  });

  describe("permission gating (own nick has no @ mode)", () => {
    it("disables op-gated items when ownModes is empty", () => {
      render(() => <UserContextMenu {...baseProps} ownModes={[]} />);
      expect(screen.getByRole("button", { name: /^op$/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /^deop$/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /^voice$/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /^devoice$/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /^kick$/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /^ban nick$/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /^ban host$/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /^kickban$/i })).toBeDisabled();
    });

    it("disabled items are NOT hidden (still rendered)", () => {
      render(() => <UserContextMenu {...baseProps} ownModes={[]} />);
      // All 6 op-gated items are in DOM but disabled.
      const opBtn = screen.getByRole("button", { name: /^op$/i });
      expect(opBtn).toBeInTheDocument();
      expect(opBtn).toBeDisabled();
    });

    it("WHOIS and Query are always enabled regardless of ownModes", () => {
      render(() => <UserContextMenu {...baseProps} ownModes={[]} />);
      expect(screen.getByRole("button", { name: /^whois$/i })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /^query$/i })).not.toBeDisabled();
    });
  });

  describe("permission gating (own nick has @ mode)", () => {
    it("enables op-gated items when ownModes includes @", () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      expect(screen.getByRole("button", { name: /^op$/i })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /^deop$/i })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /^voice$/i })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /^devoice$/i })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /^kick$/i })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /^ban nick$/i })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /^ban host$/i })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /^kickban$/i })).not.toBeDisabled();
    });
  });

  describe("actions dispatch to correct socket helpers (ownModes = [@])", () => {
    it("Op button calls pushChannelOp with networkId, channel, [nick]", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      pressAndClick(screen.getByRole("button", { name: /^op$/i }));
      expect(mockPushChannelOp).toHaveBeenCalledWith(42, "#grappa", ["alice"]);
    });

    it("Deop button calls pushChannelDeop", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      pressAndClick(screen.getByRole("button", { name: /^deop$/i }));
      expect(mockPushChannelDeop).toHaveBeenCalledWith(42, "#grappa", ["alice"]);
    });

    it("Voice button calls pushChannelVoice", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      pressAndClick(screen.getByRole("button", { name: /^voice$/i }));
      expect(mockPushChannelVoice).toHaveBeenCalledWith(42, "#grappa", ["alice"]);
    });

    it("Devoice button calls pushChannelDevoice", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      pressAndClick(screen.getByRole("button", { name: /^devoice$/i }));
      expect(mockPushChannelDevoice).toHaveBeenCalledWith(42, "#grappa", ["alice"]);
    });

    it("Kick button calls pushChannelKick with empty reason", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      pressAndClick(screen.getByRole("button", { name: /^kick$/i }));
      expect(mockPushChannelKick).toHaveBeenCalledWith(42, "#grappa", "alice", "");
    });

    it("Ban nick bans nick!*@*", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      pressAndClick(screen.getByRole("button", { name: /^ban nick$/i }));
      expect(mockPushChannelBan).toHaveBeenCalledWith(42, "#grappa", "alice!*@*");
    });

    it("Ban host with no host from the opener resolves it, then bans *!*@host", async () => {
      mockResolveUserhost.mockResolvedValue({ user: "ident", host: "alice.example.net" });
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      pressAndClick(screen.getByRole("button", { name: /^ban host$/i }));
      await flush();
      expect(mockResolveUserhost).toHaveBeenCalledWith(42, "alice");
      expect(mockPushChannelBan).toHaveBeenCalledWith(42, "#grappa", "*!*@alice.example.net");
    });

    it("Ban host with the opener's host bans it without a lookup", async () => {
      render(() => (
        <UserContextMenu {...baseProps} ownModes={["@"]} targetHost="row.example.net" />
      ));
      pressAndClick(screen.getByRole("button", { name: /^ban host$/i }));
      await flush();
      expect(mockResolveUserhost).not.toHaveBeenCalled();
      expect(mockPushChannelBan).toHaveBeenCalledWith(42, "#grappa", "*!*@row.example.net");
    });

    it("Kickban bans the CURRENT holder's host FIRST, then kicks — never the row's", async () => {
      mockResolveUserhost.mockResolvedValue({ user: "ident", host: "now.example.net" });
      render(() => (
        <UserContextMenu {...baseProps} ownModes={["@"]} targetHost="row.example.net" />
      ));
      pressAndClick(screen.getByRole("button", { name: /^kickban$/i }));
      await flush();
      expect(mockPushChannelBan).toHaveBeenCalledWith(42, "#grappa", "*!*@now.example.net");
      expect(mockPushChannelKick).toHaveBeenCalledWith(42, "#grappa", "alice", "");
      const [banOrder] = mockPushChannelBan.mock.invocationCallOrder;
      const [kickOrder] = mockPushChannelKick.mock.invocationCallOrder;
      if (banOrder === undefined || kickOrder === undefined) throw new Error("both must fire");
      expect(banOrder).toBeLessThan(kickOrder);
    });

    it("Kickban is disabled for a nick no longer in the channel", () => {
      seedFromTest(channelKey("freenode", "#grappa"), [{ nick: "bob", modes: [] }]);
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      expect(screen.getByRole("button", { name: /^kickban$/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /^ban host$/i })).not.toBeDisabled();
    });

    it("Query button calls openQueryWindowState and setSelectedChannel", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      pressAndClick(screen.getByRole("button", { name: /^query$/i }));
      expect(mockOpenQueryWindowState).toHaveBeenCalledWith(42, "alice", expect.any(String));
      expect(mockSetSelectedChannel).toHaveBeenCalledWith({
        networkSlug: "freenode",
        channelName: "alice",
        kind: "query",
      });
    });

    it("CTCP drills into the six verbs instead of acting", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      pressAndClick(screen.getByRole("button", { name: /^ctcp ▸$/i }));

      // The whole point of the group: six verbs behind ONE row, so the nick
      // menu does not grow to fourteen.
      for (const verb of ["VERSION", "TIME", "PING", "CLIENTINFO", "USERINFO", "SOURCE"]) {
        expect(
          screen.getByRole("button", { name: new RegExp(`^${verb}$`, "i") }),
        ).not.toBeDisabled();
      }
      expect(mockSendCtcpQuery).not.toHaveBeenCalled();
    });

    it("a CTCP verb dispatches against the SOURCE window, with no invented args", async () => {
      vi.spyOn(Date, "now").mockReturnValue(1706743200000);
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      pressAndClick(screen.getByRole("button", { name: /^ctcp ▸$/i }));
      pressAndClick(screen.getByRole("button", { name: /^version$/i }));

      // `sourceChannel` is the window the operator is looking at (#640) and the
      // recipient travels separately — the probe must not mint a query tab.
      // `args: ""` because a menu row has nowhere to type one, and because a
      // BARE ping is what the #637 token-less fallback correlates.
      expect(mockSendCtcpQuery).toHaveBeenCalledWith({
        networkSlug: "freenode",
        networkId: 42,
        sourceChannel: "#grappa",
        targetNick: "alice",
        verb: "VERSION",
        args: "",
        sentAtMs: 1706743200000,
      });
      vi.mocked(Date.now).mockRestore();
    });

    it("PING goes through the same door as every other verb", async () => {
      // No special case at the call site is the point: the seam decides what
      // correlates, off the VERB. A menu that hand-rolled PING here is exactly
      // the drift #1192 moved the ordering into the seam to prevent.
      vi.spyOn(Date, "now").mockReturnValue(1706743200000);
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      pressAndClick(screen.getByRole("button", { name: /^ctcp ▸$/i }));
      pressAndClick(screen.getByRole("button", { name: /^ping$/i }));

      expect(mockSendCtcpQuery).toHaveBeenCalledWith({
        networkSlug: "freenode",
        networkId: 42,
        sourceChannel: "#grappa",
        targetNick: "alice",
        verb: "PING",
        args: "",
        sentAtMs: 1706743200000,
      });
      vi.mocked(Date.now).mockRestore();
    });

    it("WHOIS button calls pushWhois with networkId and nick (server null)", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      pressAndClick(screen.getByRole("button", { name: /^whois$/i }));
      // #198 — context-menu WHOIS is single-nick: null target-server.
      expect(mockPushWhois).toHaveBeenCalledWith(42, "alice", null);
    });
  });

  describe("close behaviour", () => {
    it("calls onClose when backdrop is clicked", async () => {
      const onClose = vi.fn();
      render(() => <UserContextMenu {...baseProps} onClose={onClose} />);
      const backdrop = document.querySelector(".context-menu-backdrop");
      expect(backdrop).toBeInTheDocument();
      if (backdrop) pressAndClick(backdrop);
      expect(onClose).toHaveBeenCalled();
    });

    // #1411 — this used to fire a keydown at `document` and catch the menu's
    // own private listener. That listener is gone: Escape now arrives through
    // the ONE shared ESC stack, so the host-level assertion is that the menu
    // ENROLLED. The full door (real keypress → keybindings → stack, and the
    // drawer that no longer closes with it) is driven in cardEscape.test.tsx.
    it("enrols in the shared ESC stack, and dismisses when it is run", async () => {
      const onClose = vi.fn();
      render(() => <UserContextMenu {...baseProps} onClose={onClose} />);

      expect(overlayEscapeDepth()).toBe(1);
      expect(runTopmostOverlayEscape()).toBe(true);

      expect(onClose).toHaveBeenCalled();
    });
  });
});
