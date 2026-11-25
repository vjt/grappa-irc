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
  const networkIdBySlug = (slug: string) => networkBySlug(slug)?.id;
  // #1861 — casemappingForSlug (lib/casemapping.ts) resolves the fold
  // through this map, so the mock has to carry it.
  return { networks, user, networkBySlug, networkIdBySlug };
});

// ownNickForNetwork resolves the per-network IRC nick — return the seeded
// network nick (vjt-grappa) so the chanop gate looks it up in members. The
// rest is the real module: a rejected toggle reaches friendlyError, whose
// `instanceof ApiError` needs the real class (issue 2738).
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  ownNickForNetwork: (net: { nick: string }) => net.nick,
}));

import { friendlyError } from "../lib/friendlyError";
import { DEFAULT_ISUPPORT, seedIsupport } from "../lib/isupport";
import { closeModeModal, modeModalState, openModeModal } from "../lib/modeModal";
import { dismissOpsMenuToast, opsMenuToasts } from "../lib/opsMenu";
import { NoReply, REPLY_DEADLINE_MS } from "../lib/transportFailure";
import ModeModal from "../ModeModal";

const KEY = "bahamut #bofh";

describe("ModeModal", () => {
  beforeEach(() => {
    socketMock.pushChannelMode.mockClear();
    for (const t of opsMenuToasts()) dismissOpsMenuToast(t.id);
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

  // #975 — with the PART-time cache drop in place, "no entry for this
  // channel" is the COMMON case (any channel the session is not in), so the
  // modal has to say it rather than draw an all-off grid that reads as "+".
  it("says the modes are unknown when the channel has no cache entry", () => {
    mockMembers[KEY] = [];
    openModeModal("bahamut", "#bofh");

    const { getByTestId, queryByText } = render(() => <ModeModal />);
    expect(getByTestId("mode-modal-unknown").textContent).toContain("modes unknown");
    // The toggle grid is GONE, not merely all-off — an all-off grid is the
    // lie this issue is about.
    expect(queryByText("secret")).toBeNull();
  });

  it("renders the grid for a channel whose modes are known to be none", () => {
    // An entry present with an empty array is a real 324 answer ("+"), not
    // the unknown state. Conflating the two is the bug.
    mockModes[KEY] = { modes: [], params: {} };
    mockMembers[KEY] = [{ nick: "vjt-grappa", modes: ["@"] }];
    openModeModal("bahamut", "#bofh");

    const { queryByTestId, getByText } = render(() => <ModeModal />);
    expect(queryByTestId("mode-modal-unknown")).toBeNull();
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

  // issue 2738 (N5) — the toggle is detached (`void` before), so a rejection
  // had no sink: a server refusal was an unhandled rejection, and once pushes
  // settle at their deadline every dead link would be one too. It lands on the
  // app's detached-verb toast instead, named by the mode it tried.
  it("a toggle that gets no answer becomes a toast naming the mode", async () => {
    mockModes[KEY] = { modes: [], params: {} };
    mockMembers[KEY] = [{ nick: "vjt-grappa", modes: ["@"] }];
    const err = new NoReply(REPLY_DEADLINE_MS);
    socketMock.pushChannelMode.mockRejectedValueOnce(err);
    openModeModal("bahamut", "#bofh");

    const { getByLabelText } = render(() => <ModeModal />);
    fireEvent.click(getByLabelText(/secret/i));
    await vi.waitFor(() =>
      expect(opsMenuToasts().map((t) => t.message)).toEqual([`Mode +s: ${friendlyError(err)}`]),
    );
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
    //
    // #1302 — the map comes from JSON.parse of the serialisation MEASURED
    // on the production node, and the rank from the field the server now
    // publishes beside it. Written as a rank-ordered object literal, as it
    // was, this test passed while the modal it describes was greying that
    // founder out: an object literal keeps the order it was typed in, and
    // the wire's is alphabetical by mode letter.
    seedIsupport(1, {
      ...DEFAULT_ISUPPORT,
      prefix: JSON.parse('{"a":"&","h":"%","o":"@","q":"~","v":"+"}'),
      prefixOrder: ["q", "a", "o", "h", "v"],
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

  // #240 — param modes (+k key / +l limit) get a value input the operator
  // can SET from the modal (previously read-only in the #216 MVP).
  describe("param modes (#240)", () => {
    it("op sees a value input + Set control for a param mode (+k)", () => {
      mockModes[KEY] = { modes: [], params: {} };
      mockMembers[KEY] = [{ nick: "vjt-grappa", modes: ["@"] }];
      openModeModal("bahamut", "#bofh");

      const { getByTestId } = render(() => <ModeModal />);
      expect(getByTestId("mode-param-input-k")).toBeTruthy();
      expect(getByTestId("mode-param-set-k")).toBeTruthy();
    });

    it("op typing a key and clicking Set sends +k with the value", () => {
      mockModes[KEY] = { modes: [], params: {} };
      mockMembers[KEY] = [{ nick: "vjt-grappa", modes: ["@"] }];
      openModeModal("bahamut", "#bofh");

      const { getByTestId } = render(() => <ModeModal />);
      fireEvent.input(getByTestId("mode-param-input-k"), { target: { value: "s3cr3t" } });
      fireEvent.click(getByTestId("mode-param-set-k"));
      expect(socketMock.pushChannelMode).toHaveBeenCalledWith(1, "#bofh", "+k", ["s3cr3t"]);
    });

    it("op typing a limit and clicking Set sends +l with the value", () => {
      mockModes[KEY] = { modes: [], params: {} };
      mockMembers[KEY] = [{ nick: "vjt-grappa", modes: ["@"] }];
      openModeModal("bahamut", "#bofh");

      const { getByTestId } = render(() => <ModeModal />);
      fireEvent.input(getByTestId("mode-param-input-l"), { target: { value: "42" } });
      fireEvent.click(getByTestId("mode-param-set-l"));
      expect(socketMock.pushChannelMode).toHaveBeenCalledWith(1, "#bofh", "+l", ["42"]);
    });

    it("does not send when the value is empty or whitespace-only", () => {
      mockModes[KEY] = { modes: [], params: {} };
      mockMembers[KEY] = [{ nick: "vjt-grappa", modes: ["@"] }];
      openModeModal("bahamut", "#bofh");

      const { getByTestId } = render(() => <ModeModal />);
      fireEvent.input(getByTestId("mode-param-input-k"), { target: { value: "   " } });
      fireEvent.click(getByTestId("mode-param-set-k"));
      expect(socketMock.pushChannelMode).not.toHaveBeenCalled();
    });

    it("shows the current value and removing an active key sends -k with the key (type B)", () => {
      mockModes[KEY] = { modes: ["k"], params: { k: "oldkey" } };
      mockMembers[KEY] = [{ nick: "vjt-grappa", modes: ["@"] }];
      openModeModal("bahamut", "#bofh");

      const { getByTestId, getByText } = render(() => <ModeModal />);
      expect(getByText("oldkey")).toBeTruthy();
      fireEvent.click(getByTestId("mode-param-remove-k"));
      expect(socketMock.pushChannelMode).toHaveBeenCalledWith(1, "#bofh", "-k", ["oldkey"]);
    });

    it("removing an active limit sends a bare -l (type C, no arg)", () => {
      mockModes[KEY] = { modes: ["l"], params: { l: "42" } };
      mockMembers[KEY] = [{ nick: "vjt-grappa", modes: ["@"] }];
      openModeModal("bahamut", "#bofh");

      const { getByTestId } = render(() => <ModeModal />);
      fireEvent.click(getByTestId("mode-param-remove-l"));
      expect(socketMock.pushChannelMode).toHaveBeenCalledWith(1, "#bofh", "-l", []);
    });

    it("a non-op sees the param value read-only — no input, no Set", () => {
      mockModes[KEY] = { modes: ["k"], params: { k: "sekret" } };
      mockMembers[KEY] = [{ nick: "vjt-grappa", modes: [] }];
      openModeModal("bahamut", "#bofh");

      const { queryByTestId, getByText } = render(() => <ModeModal />);
      expect(getByText("sekret")).toBeTruthy();
      expect(queryByTestId("mode-param-input-k")).toBeNull();
      expect(queryByTestId("mode-param-set-k")).toBeNull();
    });
  });

  // issue 1831 — same defect, same cure as BanlistModal: bare `/mode` reaches
  // `openModeModal` with no `await` ahead of it, so the backdrop is mounted
  // before the tap's synthesised `click` is hit-tested and that click dismisses
  // the modal the same gesture opened. This is ALSO the pair the reporter's
  // own observation splits: the TopicBar modes button calls the very same
  // `openModeModal` and works, because there the synthesised click is consumed
  // by the button it was pressed on — the difference is the press target, not
  // the modal.
  describe("backdrop dismiss is armed by the press, not by the click (issue 1831)", () => {
    const backdropIn = (container: HTMLElement): HTMLElement => {
      const el = container.querySelector<HTMLElement>(".mode-modal-backdrop");
      if (el === null) throw new Error("no mode backdrop rendered");
      return el;
    };

    const openOne = (): void => {
      mockModes[KEY] = { modes: ["n", "t"], params: {} };
      mockMembers[KEY] = [{ nick: "vjt-grappa", modes: ["@"] }];
      openModeModal("bahamut", "#bofh");
    };

    it("ignores a click the backdrop never received a pointerdown for", () => {
      openOne();
      const { container, queryByTestId } = render(() => <ModeModal />);

      fireEvent.click(backdropIn(container));

      expect(modeModalState()).not.toBeNull();
      expect(queryByTestId("mode-modal")).not.toBeNull();
    });

    it("still dismisses on a press and release that both land on the backdrop", () => {
      openOne();
      const { container } = render(() => <ModeModal />);

      const backdrop = backdropIn(container);
      fireEvent.pointerDown(backdrop);
      fireEvent.click(backdrop);

      expect(modeModalState()).toBeNull();
    });

    it("a press that starts INSIDE the dialog does not dismiss on release", () => {
      openOne();
      const { container, getByTestId } = render(() => <ModeModal />);

      fireEvent.pointerDown(getByTestId("mode-modal"));
      fireEvent.click(backdropIn(container));

      expect(modeModalState()).not.toBeNull();
    });
  });
});
