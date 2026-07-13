import { fireEvent, render } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #216 — /mode viewer/editor modal component tests. The modal renders
// toggle buttons for the network's available channel modes (from
// ISUPPORT), reflects the channel's current modes, and gates editing on
// the operator holding @/% in that channel.

const socketMock = vi.hoisted(() => ({ pushChannelMode: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/socket", () => socketMock);

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
}));

// Overlay lock is a no-op in jsdom (no real scroller); stub it.
vi.mock("../lib/overlayScrollLock", () => ({ createOverlayLock: vi.fn() }));

let mockModes: Record<string, { modes: string[]; params: Record<string, string | null> }> = {};
let mockMembers: Record<string, Array<{ nick: string; modes: string[] }>> = {};

vi.mock("../lib/channelTopic", () => ({
  modesByChannel: () => mockModes,
}));

vi.mock("../lib/members", () => ({
  membersByChannel: () => mockMembers,
}));

vi.mock("../lib/networks", () => {
  const networks = vi.fn(() => [
    { id: 1, slug: "bahamut", nick: "vjt-grappa", inserted_at: "x", updated_at: "y" },
  ]);
  const user = vi.fn(() => ({
    kind: "user",
    id: "u1",
    name: "vjt",
    is_admin: false,
    inserted_at: "x",
  }));
  const networkBySlug = (slug: string) => networks()?.find((n) => n.slug === slug);
  return { networks, user, networkBySlug };
});

// ownNickForNetwork resolves the per-network IRC nick — return the seeded
// network nick (vjt-grappa) so the chanop gate looks it up in members.
vi.mock("../lib/api", () => ({
  ownNickForNetwork: (net: { nick: string }) => net.nick,
}));

import { DEFAULT_ISUPPORT, seedIsupport } from "../lib/isupport";
import { closeModeModal, openModeModal } from "../lib/modeModal";
import ModeModal from "../ModeModal";

const KEY = "bahamut #bofh";

describe("ModeModal", () => {
  beforeEach(() => {
    socketMock.pushChannelMode.mockClear();
    mockModes = {};
    mockMembers = {};
    seedIsupport(1, DEFAULT_ISUPPORT);
    closeModeModal();
  });

  it("renders nothing when closed", () => {
    const { queryByTestId } = render(() => <ModeModal />);
    expect(queryByTestId("mode-modal")).toBeNull();
  });

  it("renders toggle buttons for the network's available modes when open", () => {
    mockModes[KEY] = { modes: ["n", "t"], params: {} };
    mockMembers[KEY] = [{ nick: "vjt-grappa", modes: ["@"] }];
    openModeModal("bahamut", "#bofh");

    const { getByTestId, getByText } = render(() => <ModeModal />);
    expect(getByTestId("mode-modal")).toBeTruthy();
    expect(getByText("secret")).toBeTruthy();
  });

  it("shows active modes as pressed", () => {
    mockModes[KEY] = { modes: ["s"], params: {} };
    mockMembers[KEY] = [{ nick: "vjt-grappa", modes: ["@"] }];
    openModeModal("bahamut", "#bofh");

    const { getByLabelText } = render(() => <ModeModal />);
    const secretToggle = getByLabelText(/secret/i);
    expect(secretToggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("op toggling an inactive flag mode sends +<letter>", () => {
    mockModes[KEY] = { modes: [], params: {} };
    mockMembers[KEY] = [{ nick: "vjt-grappa", modes: ["@"] }];
    openModeModal("bahamut", "#bofh");

    const { getByLabelText } = render(() => <ModeModal />);
    fireEvent.click(getByLabelText(/secret/i));
    expect(socketMock.pushChannelMode).toHaveBeenCalledWith(1, "#bofh", "+s", []);
  });

  it("op toggling an active flag mode sends -<letter>", () => {
    mockModes[KEY] = { modes: ["s"], params: {} };
    mockMembers[KEY] = [{ nick: "vjt-grappa", modes: ["@"] }];
    openModeModal("bahamut", "#bofh");

    const { getByLabelText } = render(() => <ModeModal />);
    fireEvent.click(getByLabelText(/secret/i));
    expect(socketMock.pushChannelMode).toHaveBeenCalledWith(1, "#bofh", "-s", []);
  });

  it("halfop can also edit (@/% both grant edit)", () => {
    mockModes[KEY] = { modes: [], params: {} };
    mockMembers[KEY] = [{ nick: "vjt-grappa", modes: ["%"] }];
    openModeModal("bahamut", "#bofh");

    const { getByLabelText } = render(() => <ModeModal />);
    fireEvent.click(getByLabelText(/secret/i));
    expect(socketMock.pushChannelMode).toHaveBeenCalledWith(1, "#bofh", "+s", []);
  });

  it("a founder (~) on a PREFIX-rich network can edit even without @", () => {
    // PREFIX=(qaohv)~&@%+ — a founder who does NOT also hold @ must still
    // get an editable modal (editorSigils ranks ~ above op). #216 review.
    seedIsupport(1, {
      chanmodes: DEFAULT_ISUPPORT.chanmodes,
      prefix: { q: "~", a: "&", o: "@", h: "%", v: "+" },
    });
    mockModes[KEY] = { modes: [], params: {} };
    mockMembers[KEY] = [{ nick: "vjt-grappa", modes: ["~"] }];
    openModeModal("bahamut", "#bofh");

    const { getByLabelText } = render(() => <ModeModal />);
    fireEvent.click(getByLabelText(/secret/i));
    expect(socketMock.pushChannelMode).toHaveBeenCalledWith(1, "#bofh", "+s", []);
  });

  it("a non-op sees read-only toggles and cannot send a mode change", () => {
    mockModes[KEY] = { modes: ["n"], params: {} };
    mockMembers[KEY] = [{ nick: "vjt-grappa", modes: [] }];
    openModeModal("bahamut", "#bofh");

    const { getByLabelText } = render(() => <ModeModal />);
    const noExternal = getByLabelText(/no external/i);
    expect(noExternal.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(noExternal);
    expect(socketMock.pushChannelMode).not.toHaveBeenCalled();
  });
});
