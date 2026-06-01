import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// UX-2 (2026-05-17) — Mobile archive modal.
//
// Stateless w.r.t. open/closed — driven by `archiveModalNetwork()`
// signal from `lib/archive.ts`. When the signal is non-null, the modal
// renders a list of `visibleArchiveForNetwork(slug, id)` entries with
// per-row InlineConfirmButton (UX-1's delete affordance) for each.
//
// Tests cover: closed-state (renders nothing), open with entries (list
// + delete buttons), open with empty (empty banner), tap entry (selects
// + closes), tap delete twice (arms + calls deleteArchiveEntry), tap
// close × / backdrop (clears the signal).

vi.mock("../lib/selection", () => ({
  setSelectedChannel: vi.fn(),
  applySeedEnvelope: vi.fn(),
}));

vi.mock("../lib/networks", () => ({
  networks: () => [
    { id: 1, slug: "freenode", inserted_at: "", updated_at: "" },
    { id: 2, slug: "libera", inserted_at: "", updated_at: "" },
  ],
}));

vi.mock("../lib/api", () => ({
  deleteArchiveEntry: vi.fn().mockResolvedValue(undefined),
  // 2026-06-01 (unread-badges-from-cursor cluster, bucket B2):
  // selection.ts now imports isContentKind from api.ts for the badge
  // memo derivation. Any test importing selection (directly or
  // transitively) needs the classifier in its api mock.
  isContentKind: (k: string) => k === "privmsg" || k === "notice" || k === "action",
  isPresenceKind: (k: string) => !(k === "privmsg" || k === "notice" || k === "action"),
}));

vi.mock("../lib/auth", () => ({
  token: () => "test-token",
}));

const { mockSlug, mockEntries, setArchiveModalNetwork, loadArchive } = vi.hoisted(() => ({
  mockSlug: vi.fn<() => string | null>(() => null),
  mockEntries: vi.fn<
    (
      slug: string,
      id: number,
    ) => Array<{
      target: string;
      kind: "channel" | "query";
      last_activity: number;
      row_count: number;
    }>
  >(() => []),
  setArchiveModalNetwork: vi.fn(),
  loadArchive: vi.fn<(slug: string) => Promise<void>>().mockResolvedValue(undefined),
}));

vi.mock("../lib/archive", () => ({
  archiveModalNetwork: () => mockSlug(),
  setArchiveModalNetwork,
  loadArchive,
  visibleArchiveForNetwork: (slug: string, id: number) => mockEntries(slug, id),
}));

import ArchiveModal from "../ArchiveModal";
import * as apiMod from "../lib/api";
import * as selMod from "../lib/selection";

beforeEach(() => {
  vi.clearAllMocks();
  mockSlug.mockReturnValue(null);
  mockEntries.mockReturnValue([]);
});

describe("ArchiveModal", () => {
  it("renders nothing when archiveModalNetwork() is null", () => {
    const { container } = render(() => <ArchiveModal />);
    expect(container.querySelector(".archive-modal-backdrop")).toBeNull();
  });

  it("renders the dialog with header containing the slug when modal is open", () => {
    mockSlug.mockReturnValue("freenode");
    render(() => <ArchiveModal />);
    const header = screen.getByText(/Archive — freenode/);
    expect(header).toBeInTheDocument();
  });

  it("renders one row per visible archive entry", () => {
    mockSlug.mockReturnValue("freenode");
    mockEntries.mockReturnValue([
      { target: "vjt-peer", kind: "query", last_activity: 100, row_count: 4 },
      { target: "#bofh", kind: "channel", last_activity: 200, row_count: 8 },
    ]);
    const { container } = render(() => <ArchiveModal />);
    const rows = container.querySelectorAll(".archive-modal-row");
    expect(rows.length).toBe(2);
    expect(screen.getByText("vjt-peer")).toBeInTheDocument();
    expect(screen.getByText("#bofh")).toBeInTheDocument();
  });

  it("renders an empty banner when modal is open but entries are empty", () => {
    mockSlug.mockReturnValue("freenode");
    mockEntries.mockReturnValue([]);
    render(() => <ArchiveModal />);
    expect(screen.getByText("no archived windows")).toBeInTheDocument();
  });

  it("clicking the × close button calls setArchiveModalNetwork(null)", () => {
    mockSlug.mockReturnValue("freenode");
    render(() => <ArchiveModal />);
    const closeBtn = screen.getByLabelText("close archive");
    fireEvent.click(closeBtn);
    expect(setArchiveModalNetwork).toHaveBeenCalledWith(null);
  });

  it("clicking the backdrop calls setArchiveModalNetwork(null)", () => {
    mockSlug.mockReturnValue("freenode");
    const { container } = render(() => <ArchiveModal />);
    const backdrop = container.querySelector(".archive-modal-backdrop") as HTMLElement;
    fireEvent.click(backdrop);
    expect(setArchiveModalNetwork).toHaveBeenCalledWith(null);
  });

  it("clicking the dialog itself does NOT close (stopPropagation)", () => {
    mockSlug.mockReturnValue("freenode");
    const { container } = render(() => <ArchiveModal />);
    const dialog = container.querySelector(".archive-modal") as HTMLElement;
    fireEvent.click(dialog);
    expect(setArchiveModalNetwork).not.toHaveBeenCalled();
  });

  it("clicking an entry row selects the channel + closes the modal (channel kind)", () => {
    mockSlug.mockReturnValue("freenode");
    mockEntries.mockReturnValue([
      { target: "#bofh", kind: "channel", last_activity: 200, row_count: 8 },
    ]);
    render(() => <ArchiveModal />);
    fireEvent.click(screen.getByText("#bofh"));
    expect(selMod.setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channelName: "#bofh",
      kind: "channel",
    });
    expect(setArchiveModalNetwork).toHaveBeenCalledWith(null);
  });

  it("clicking an entry row selects the channel + closes the modal (query kind)", () => {
    mockSlug.mockReturnValue("freenode");
    mockEntries.mockReturnValue([
      { target: "vjt-peer", kind: "query", last_activity: 100, row_count: 4 },
    ]);
    render(() => <ArchiveModal />);
    fireEvent.click(screen.getByText("vjt-peer"));
    expect(selMod.setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channelName: "vjt-peer",
      kind: "query",
    });
    expect(setArchiveModalNetwork).toHaveBeenCalledWith(null);
  });

  it("first click on × delete arms (label flips to 'really delete?')", () => {
    mockSlug.mockReturnValue("freenode");
    mockEntries.mockReturnValue([
      { target: "vjt-peer", kind: "query", last_activity: 100, row_count: 4 },
    ]);
    render(() => <ArchiveModal />);
    const deleteBtn = screen.getByTestId("archive-modal-delete-freenode-vjt-peer");
    expect(deleteBtn.textContent).toBe("×");
    fireEvent.click(deleteBtn);
    expect(deleteBtn.textContent).toBe("really delete?");
    expect(apiMod.deleteArchiveEntry).not.toHaveBeenCalled();
  });

  it("second click on × delete calls deleteArchiveEntry with token + slug + target", async () => {
    mockSlug.mockReturnValue("freenode");
    mockEntries.mockReturnValue([
      { target: "vjt-peer", kind: "query", last_activity: 100, row_count: 4 },
    ]);
    render(() => <ArchiveModal />);
    const deleteBtn = screen.getByTestId("archive-modal-delete-freenode-vjt-peer");
    fireEvent.click(deleteBtn);
    fireEvent.click(deleteBtn);
    await new Promise((r) => setTimeout(r, 0));
    expect(apiMod.deleteArchiveEntry).toHaveBeenCalledWith("test-token", "freenode", "vjt-peer");
  });
});

// BUGHUNT-1 B — seed Archive list on edge-trigger open.
//
// Root cause: mobile BottomBar chip opens the modal via
// setArchiveModalNetwork but never calls loadArchive — only Sidebar's
// <details> onToggle does. Modal renders "no archived windows" until
// the user archives a new window (which fires archive_changed → cic
// re-fetches and the bug appears fixed). Fix is a dedicated
// createEffect inside ArchiveModal that fires loadArchive on
// edge-trigger open.
describe("ArchiveModal seed-on-open (BUGHUNT-1 B)", () => {
  it("does not load anything while archiveModalNetwork() is null", () => {
    mockSlug.mockReturnValue(null);
    render(() => <ArchiveModal />);
    expect(loadArchive).not.toHaveBeenCalled();
  });

  it("calls loadArchive(slug) when archiveModalNetwork() flips null → slug", async () => {
    mockSlug.mockReturnValue("freenode");
    render(() => <ArchiveModal />);
    // createEffect runs eagerly on mount; the initial slug counts as
    // an edge-trigger from null → "freenode".
    await new Promise((r) => setTimeout(r, 0));
    expect(loadArchive).toHaveBeenCalledWith("freenode");
    expect(loadArchive).toHaveBeenCalledTimes(1);
  });
});
