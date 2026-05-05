import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// C5.1 — UserContextMenu: right-click submenu on member nick.
//
// Tests assert:
//   1. All 8 items render (op/deop/voice/devoice/kick/ban/WHOIS/query).
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
const mockOpenQueryWindowState = vi.fn();
const mockSetSelectedChannel = vi.fn();

vi.mock("../lib/socket", () => ({
  pushChannelOp: (...args: unknown[]) => mockPushChannelOp(...args),
  pushChannelDeop: (...args: unknown[]) => mockPushChannelDeop(...args),
  pushChannelVoice: (...args: unknown[]) => mockPushChannelVoice(...args),
  pushChannelDevoice: (...args: unknown[]) => mockPushChannelDevoice(...args),
  pushChannelKick: (...args: unknown[]) => mockPushChannelKick(...args),
  pushChannelBan: (...args: unknown[]) => mockPushChannelBan(...args),
  pushWhois: (...args: unknown[]) => mockPushWhois(...args),
}));

vi.mock("../lib/networks", () => ({
  networks: vi.fn(() => [{ id: 42, slug: "freenode", inserted_at: "x", updated_at: "y" }]),
}));

vi.mock("../lib/queryWindows", () => ({
  openQueryWindowState: (...args: unknown[]) => mockOpenQueryWindowState(...args),
  queryWindowsByNetwork: vi.fn(() => ({})),
}));

vi.mock("../lib/selection", () => ({
  setSelectedChannel: (...args: unknown[]) => mockSetSelectedChannel(...args),
  selectedChannel: vi.fn(() => null),
}));

// We also need to mock pushWhois — UserContextMenu uses pushWhois from socket.ts.
// The mock above covers it.

import UserContextMenu from "../UserContextMenu";

const baseProps = {
  networkSlug: "freenode",
  networkId: 42,
  channelName: "#grappa",
  targetNick: "alice",
  ownModes: [] as string[],
  position: { x: 100, y: 200 },
  onClose: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("UserContextMenu", () => {
  describe("renders all 8 items", () => {
    it("shows Op, Deop, Voice, Devoice, Kick, Ban, WHOIS, Query", () => {
      render(() => <UserContextMenu {...baseProps} />);
      expect(screen.getByRole("button", { name: /^op$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^deop$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^voice$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^devoice$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^kick$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^ban$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^whois$/i })).toBeInTheDocument();
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
      expect(screen.getByRole("button", { name: /^ban$/i })).toBeDisabled();
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
      expect(screen.getByRole("button", { name: /^ban$/i })).not.toBeDisabled();
    });
  });

  describe("actions dispatch to correct socket helpers (ownModes = [@])", () => {
    it("Op button calls pushChannelOp with networkId, channel, [nick]", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      fireEvent.click(screen.getByRole("button", { name: /^op$/i }));
      expect(mockPushChannelOp).toHaveBeenCalledWith(42, "#grappa", ["alice"]);
    });

    it("Deop button calls pushChannelDeop", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      fireEvent.click(screen.getByRole("button", { name: /^deop$/i }));
      expect(mockPushChannelDeop).toHaveBeenCalledWith(42, "#grappa", ["alice"]);
    });

    it("Voice button calls pushChannelVoice", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      fireEvent.click(screen.getByRole("button", { name: /^voice$/i }));
      expect(mockPushChannelVoice).toHaveBeenCalledWith(42, "#grappa", ["alice"]);
    });

    it("Devoice button calls pushChannelDevoice", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      fireEvent.click(screen.getByRole("button", { name: /^devoice$/i }));
      expect(mockPushChannelDevoice).toHaveBeenCalledWith(42, "#grappa", ["alice"]);
    });

    it("Kick button calls pushChannelKick with empty reason", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      fireEvent.click(screen.getByRole("button", { name: /^kick$/i }));
      expect(mockPushChannelKick).toHaveBeenCalledWith(42, "#grappa", "alice", "");
    });

    it("Ban button calls pushChannelBan with nick!*@* fallback mask", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      fireEvent.click(screen.getByRole("button", { name: /^ban$/i }));
      expect(mockPushChannelBan).toHaveBeenCalledWith(42, "#grappa", "alice!*@*");
    });

    it("Query button calls openQueryWindowState and setSelectedChannel", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      fireEvent.click(screen.getByRole("button", { name: /^query$/i }));
      expect(mockOpenQueryWindowState).toHaveBeenCalledWith(42, "alice", expect.any(String));
      expect(mockSetSelectedChannel).toHaveBeenCalledWith({
        networkSlug: "freenode",
        channelName: "alice",
        kind: "query",
      });
    });

    it("WHOIS button calls pushWhois with networkId and nick", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      fireEvent.click(screen.getByRole("button", { name: /^whois$/i }));
      expect(mockPushWhois).toHaveBeenCalledWith(42, "alice");
    });
  });

  describe("close behaviour", () => {
    it("calls onClose when backdrop is clicked", async () => {
      const onClose = vi.fn();
      render(() => <UserContextMenu {...baseProps} onClose={onClose} />);
      const backdrop = document.querySelector(".context-menu-backdrop");
      expect(backdrop).toBeInTheDocument();
      if (backdrop) fireEvent.click(backdrop);
      expect(onClose).toHaveBeenCalled();
    });

    it("calls onClose when Escape is pressed", async () => {
      const onClose = vi.fn();
      render(() => <UserContextMenu {...baseProps} onClose={onClose} />);
      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).toHaveBeenCalled();
    });
  });
});
