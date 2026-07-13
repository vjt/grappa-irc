import { fireEvent, render } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #229 — /umode viewer/editor modal component tests. The modal renders
// toggle buttons for the known umodes, reflects the operator's active
// umode set, and pushes the `umode` WS verb on toggling a SETTABLE umode
// (server/services-managed ones are read-only).

const socketMock = vi.hoisted(() => ({ pushChannelUmode: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/socket", () => socketMock);

// Overlay lock is a no-op in jsdom (no real scroller); stub it.
vi.mock("../lib/overlayScrollLock", () => ({ createOverlayLock: vi.fn() }));

vi.mock("../lib/networks", () => ({
  networkIdBySlug: (slug: string) => (slug === "bahamut" ? 1 : undefined),
}));

let mockUmodes: Record<number, string[]> = {};
vi.mock("../lib/umodes", () => ({
  umodesForNetwork: (id: number) => mockUmodes[id] ?? [],
}));

import { closeUmodeModal, openUmodeModal } from "../lib/umodeModal";
import UmodeModal from "../UmodeModal";

describe("UmodeModal", () => {
  beforeEach(() => {
    socketMock.pushChannelUmode.mockClear();
    mockUmodes = {};
    closeUmodeModal();
  });

  it("renders nothing when closed", () => {
    const { queryByTestId } = render(() => <UmodeModal />);
    expect(queryByTestId("umode-modal")).toBeNull();
  });

  it("renders toggle buttons for the known umodes when open", () => {
    mockUmodes[1] = [];
    openUmodeModal("bahamut");

    const { getByTestId, getByText } = render(() => <UmodeModal />);
    expect(getByTestId("umode-modal")).toBeTruthy();
    expect(getByText("invisible")).toBeTruthy();
  });

  it("shows active umodes as pressed", () => {
    mockUmodes[1] = ["i"];
    openUmodeModal("bahamut");

    const { getByLabelText } = render(() => <UmodeModal />);
    expect(getByLabelText(/invisible/i).getAttribute("aria-pressed")).toBe("true");
  });

  it("toggling an inactive settable umode sends +<letter>", () => {
    mockUmodes[1] = [];
    openUmodeModal("bahamut");

    const { getByLabelText } = render(() => <UmodeModal />);
    fireEvent.click(getByLabelText(/invisible/i));
    expect(socketMock.pushChannelUmode).toHaveBeenCalledWith(1, "+i");
  });

  it("toggling an active settable umode sends -<letter>", () => {
    mockUmodes[1] = ["i"];
    openUmodeModal("bahamut");

    const { getByLabelText } = render(() => <UmodeModal />);
    fireEvent.click(getByLabelText(/invisible/i));
    expect(socketMock.pushChannelUmode).toHaveBeenCalledWith(1, "-i");
  });

  it("a server-managed umode (+r) is read-only and cannot be toggled", () => {
    mockUmodes[1] = ["r"];
    openUmodeModal("bahamut");

    const { getByLabelText } = render(() => <UmodeModal />);
    const registered = getByLabelText(/registered/i);
    expect(registered.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(registered);
    expect(socketMock.pushChannelUmode).not.toHaveBeenCalled();
  });

  it("surfaces an active-but-unknown vendor umode read-only (no crash)", () => {
    mockUmodes[1] = ["Z"];
    openUmodeModal("bahamut");

    const { getByLabelText } = render(() => <UmodeModal />);
    const vendor = getByLabelText(/\+Z/);
    expect(vendor.getAttribute("aria-pressed")).toBe("true");
    expect(vendor.getAttribute("aria-disabled")).toBe("true");
  });
});
