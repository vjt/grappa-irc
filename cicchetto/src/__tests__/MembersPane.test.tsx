import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// CP15 B5: MembersPane no longer fetches /members. Server pushes
// `members_seeded` on after_join (B3); the once-per-channel REST gate
// is gone. Render branches now read `windowStateByChannel[key]`:
//   - state ∉ {joined}: "not joined" muted text (no fetch).
//   - state == joined && members empty/undefined: "loading…" muted.
//   - state == joined && members non-empty: render the list.

let mockMembers: Record<string, Array<{ nick: string; modes: string[] }>> = {};
let mockWindowState: Record<string, string> = {};

vi.mock("../lib/members", () => ({
  membersByChannel: () => mockMembers,
}));

vi.mock("../lib/windowState", () => ({
  windowStateByChannel: () => mockWindowState,
}));

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
}));

// MembersPane imports `networks` + `user` for own-nick lookup and
// networkId resolution. Mock both so render tests don't drag in
// the full auth / localStorage stack.
vi.mock("../lib/networks", () => ({
  networks: vi.fn(() => [{ id: 1, slug: "freenode", inserted_at: "x", updated_at: "y" }]),
  user: vi.fn(() => ({ kind: "user", id: "u1", name: "vjt", inserted_at: "x" })),
}));

// UserContextMenu is mounted by MembersPane on right-click; stub it so
// these render tests don't need to pull in its full dependency tree.
vi.mock("../UserContextMenu", () => ({
  default: () => <div data-testid="context-menu-stub" />,
}));

// Spec #5 — left-click on a member opens a query window AND switches
// focus. Stub queryWindows + selection so we can assert the verb calls
// without dragging the real stores into render tests.
vi.mock("../lib/queryWindows", () => ({
  openQueryWindowState: vi.fn(),
}));
vi.mock("../lib/selection", () => ({
  setSelectedChannel: vi.fn(),
}));

import MembersPane from "../MembersPane";

beforeEach(() => {
  vi.clearAllMocks();
  mockMembers = {};
  mockWindowState = {};
});

describe("MembersPane", () => {
  it("renders members with mode-tier classes when state=joined + non-empty list", () => {
    mockWindowState = { "freenode #italia": "joined" };
    mockMembers = {
      "freenode #italia": [
        { nick: "vjt", modes: ["@"] },
        { nick: "alice", modes: ["+"] },
        { nick: "bob", modes: [] },
      ],
    };
    render(() => <MembersPane networkSlug="freenode" channelName="#italia" />);
    const op = document.querySelector(".member-op");
    expect(op?.textContent).toContain("vjt");
    const voiced = document.querySelector(".member-voiced");
    expect(voiced?.textContent).toContain("alice");
    const plain = document.querySelector(".member-plain");
    expect(plain?.textContent).toContain("bob");
  });

  it("renders the count in the heading when state=joined + non-empty list", () => {
    mockWindowState = { "freenode #italia": "joined" };
    mockMembers = {
      "freenode #italia": [
        { nick: "vjt", modes: ["@"] },
        { nick: "alice", modes: ["+"] },
        { nick: "bob", modes: [] },
      ],
    };
    render(() => <MembersPane networkSlug="freenode" channelName="#italia" />);
    expect(screen.getByText(/members \(3\)/i)).toBeInTheDocument();
  });

  it("renders 'loading…' when state=joined but members snapshot is empty", () => {
    mockWindowState = { "freenode #italia": "joined" };
    mockMembers = {};
    render(() => <MembersPane networkSlug="freenode" channelName="#italia" />);
    expect(screen.getByText(/loading…/i)).toBeInTheDocument();
  });

  it("renders 'loading…' when state=joined and members entry is an empty array", () => {
    mockWindowState = { "freenode #italia": "joined" };
    mockMembers = { "freenode #italia": [] };
    render(() => <MembersPane networkSlug="freenode" channelName="#italia" />);
    expect(screen.getByText(/loading…/i)).toBeInTheDocument();
  });

  it("renders 'not joined' when state=failed (no fetch, no list)", () => {
    mockWindowState = { "freenode #cic-test-pending": "failed" };
    render(() => <MembersPane networkSlug="freenode" channelName="#cic-test-pending" />);
    expect(screen.getByText(/not joined/i)).toBeInTheDocument();
  });

  it("renders 'not joined' when state=kicked", () => {
    mockWindowState = { "freenode #italia": "kicked" };
    render(() => <MembersPane networkSlug="freenode" channelName="#italia" />);
    expect(screen.getByText(/not joined/i)).toBeInTheDocument();
  });

  it("renders 'not joined' when state=parked", () => {
    mockWindowState = { "freenode #italia": "parked" };
    render(() => <MembersPane networkSlug="freenode" channelName="#italia" />);
    expect(screen.getByText(/not joined/i)).toBeInTheDocument();
  });

  it("renders 'not joined' when state=pending (window opened, JOIN in flight)", () => {
    mockWindowState = { "freenode #italia": "pending" };
    render(() => <MembersPane networkSlug="freenode" channelName="#italia" />);
    expect(screen.getByText(/not joined/i)).toBeInTheDocument();
  });

  it("renders 'not joined' when no window-state entry exists at all", () => {
    mockWindowState = {};
    render(() => <MembersPane networkSlug="freenode" channelName="#italia" />);
    expect(screen.getByText(/not joined/i)).toBeInTheDocument();
  });

  // Spec #5 — left-click on a member opens a query window for that nick
  // AND switches focus. Right-click still opens the context menu (covered
  // separately); the two click verbs do NOT compete (left vs right are
  // independent MouseEvent buttons).
  it("left-click on a member opens a query window AND switches focus to it", async () => {
    const qw = await import("../lib/queryWindows");
    const sel = await import("../lib/selection");
    mockWindowState = { "freenode #italia": "joined" };
    mockMembers = {
      "freenode #italia": [
        { nick: "vjt", modes: ["@"] },
        { nick: "alice", modes: ["+"] },
      ],
    };
    render(() => <MembersPane networkSlug="freenode" channelName="#italia" />);
    const aliceLi = document.querySelector(".member-voiced") as HTMLElement;
    fireEvent.click(aliceLi);
    expect(qw.openQueryWindowState).toHaveBeenCalledWith(1, "alice", expect.any(String));
    expect(sel.setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channelName: "alice",
      kind: "query",
    });
  });

  it("left-click is a no-op when network is unresolved (race: list arrives before networks)", async () => {
    const { networks } = await import("../lib/networks");
    vi.mocked(networks).mockReturnValueOnce([]);
    const qw = await import("../lib/queryWindows");
    const sel = await import("../lib/selection");
    mockWindowState = { "freenode #italia": "joined" };
    mockMembers = { "freenode #italia": [{ nick: "alice", modes: [] }] };
    render(() => <MembersPane networkSlug="freenode" channelName="#italia" />);
    const li = document.querySelector(".member-plain") as HTMLElement;
    fireEvent.click(li);
    expect(qw.openQueryWindowState).not.toHaveBeenCalled();
    expect(sel.setSelectedChannel).not.toHaveBeenCalled();
  });
});
