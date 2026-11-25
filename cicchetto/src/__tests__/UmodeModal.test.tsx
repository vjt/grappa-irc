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

// #249 — server-advertised supported-umode set. Empty (unseeded) → the modal
// falls back to the static table, exercising the pre-#249 behavior in every
// test that doesn't set it.
let mockSupported: Record<number, string[]> = {};
vi.mock("../lib/supportedUmodes", () => ({
  supportedUmodesForNetwork: (id: number) => mockSupported[id] ?? [],
}));

import { friendlyError } from "../lib/friendlyError";
import { dismissOpsMenuToast, opsMenuToasts } from "../lib/opsMenu";
import { NoReply, REPLY_DEADLINE_MS } from "../lib/transportFailure";
import { closeUmodeModal, openUmodeModal } from "../lib/umodeModal";
import UmodeModal from "../UmodeModal";

describe("UmodeModal", () => {
  beforeEach(() => {
    socketMock.pushChannelUmode.mockClear();
    for (const t of opsMenuToasts()) dismissOpsMenuToast(t.id);
    mockUmodes = {};
    mockSupported = {};
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

  // issue 2738 (N5) — same detached-toggle sink as ModeModal.
  it("a toggle that gets no answer becomes a toast naming the user mode", async () => {
    mockUmodes[1] = [];
    const err = new NoReply(REPLY_DEADLINE_MS);
    socketMock.pushChannelUmode.mockRejectedValueOnce(err);
    openUmodeModal("bahamut");

    const { getByLabelText } = render(() => <UmodeModal />);
    fireEvent.click(getByLabelText(/invisible/i));
    await vi.waitFor(() =>
      expect(opsMenuToasts().map((t) => t.message)).toEqual([
        `User mode +i: ${friendlyError(err)}`,
      ]),
    );
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

  // issue 1982 — the same defect issue 1831 cured on BanlistModal and
  // ModeModal, on the sibling it did not reach. `umodeViewCommand` (bare
  // `/umode`) and `umodeTargetViewCommand` (`/mode <ownnick>`) both call
  // `openUmodeModal` with no `await` ahead of it, so the scrim is mounted while
  // the finger is still down and the tap's synthesised click lands on it.
  // Nothing about this arm is umode-specific: it is the shared cure applied to
  // the third of five compose-reachable overlays.
  describe("backdrop dismiss is armed by the press, not by the click (issue 1982)", () => {
    const backdropIn = (container: HTMLElement): HTMLElement => {
      const el = container.querySelector<HTMLElement>(".mode-modal-backdrop");
      if (el === null) throw new Error("no umode backdrop rendered");
      return el;
    };

    it("ignores a click the backdrop never received a pointerdown for", () => {
      mockUmodes[1] = [];
      openUmodeModal("bahamut");
      const { container, queryByTestId } = render(() => <UmodeModal />);

      fireEvent.click(backdropIn(container));

      expect(queryByTestId("umode-modal")).not.toBeNull();
    });

    it("still dismisses on a press and release that both land on the backdrop", () => {
      mockUmodes[1] = [];
      openUmodeModal("bahamut");
      const { container, queryByTestId } = render(() => <UmodeModal />);

      const backdrop = backdropIn(container);
      fireEvent.pointerDown(backdrop);
      fireEvent.click(backdrop);

      expect(queryByTestId("umode-modal")).toBeNull();
    });

    it("a press that starts INSIDE the dialog does not dismiss on release", () => {
      mockUmodes[1] = [];
      openUmodeModal("bahamut");
      const { container, getByTestId, queryByTestId } = render(() => <UmodeModal />);

      fireEvent.pointerDown(getByTestId("umode-modal"));
      fireEvent.click(backdropIn(container));

      expect(queryByTestId("umode-modal")).not.toBeNull();
    });
  });

  it("renders only the server-advertised umodes when the server sent a set (#249)", () => {
    // The server advertised only +i (invisible) and +x (masked host); the
    // modal renders exactly those, NOT the full static table.
    mockUmodes[1] = [];
    mockSupported[1] = ["i", "x"];
    openUmodeModal("bahamut");

    const { getByText, queryByText } = render(() => <UmodeModal />);
    expect(getByText("invisible")).toBeTruthy();
    expect(getByText("masked host")).toBeTruthy();
    // +w (wallops) is in the static table but was NOT advertised — absent.
    expect(queryByText("wallops")).toBeNull();
  });
});
