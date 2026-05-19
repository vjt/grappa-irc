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

vi.mock("../lib/members", async () => {
  // Re-export the real `sortMembers` so render tests exercise the
  // actual sort routine (bucket J). `membersByChannel` stays stubbed
  // so we can drive the render with arbitrary fixtures.
  const real = await vi.importActual<typeof import("../lib/members")>("../lib/members");
  return {
    membersByChannel: () => mockMembers,
    sortMembers: real.sortMembers,
  };
});

vi.mock("../lib/windowState", () => ({
  windowStateByChannel: () => mockWindowState,
}));

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
}));

// MembersPane imports `networks` + `user` for own-nick lookup and
// networkId resolution. Mock both so render tests don't drag in
// the full auth / localStorage stack. networkBySlug derives from the
// same `networks()` source — provided as a module-level helper so
// MembersPane can use the canonical bnd-A2 lookup.
vi.mock("../lib/networks", () => {
  const networks = vi.fn(() => [
    { id: 1, slug: "freenode", nick: "vjt", inserted_at: "x", updated_at: "y" },
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
  canonicalQueryNick: (_networkId: number, nick: string) => nick,
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
    expect(op?.textContent).toContain("@vjt");
    const voiced = document.querySelector(".member-voiced");
    expect(voiced?.textContent).toContain("+alice");
    const plain = document.querySelector(".member-plain");
    // UX-5 bucket BC2: plain (no-mode) members render with NO prefix
    // glyph — the pre-BC2 column-alignment space (` bob`) is moot
    // once the prefix gets its own bold/colored span. Just the bare
    // nick. Op/voiced rows verify the prefix is still present via
    // `@vjt` / `+alice` above.
    expect(plain?.textContent).toContain("bob");
    expect(plain?.textContent).not.toContain(" bob");
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
  // independent MouseEvent buttons). The clickable target is a <button>
  // nested inside the <li> (a11y: lists themselves are non-interactive
  // per WAI-ARIA).
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
    const aliceBtn = document.querySelector(".member-voiced .member-name") as HTMLElement;
    fireEvent.click(aliceBtn);
    expect(qw.openQueryWindowState).toHaveBeenCalledWith(1, "alice", expect.any(String));
    expect(sel.setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channelName: "alice",
      kind: "query",
    });
  });

  it("left-click is a no-op when network is unresolved (race: list arrives before networks)", async () => {
    const { networks } = await import("../lib/networks");
    // Cast: the mock factory above types `networks` as a `vi.fn(() => [...])`
    // with the seed array's literal type; an empty replacement on a single
    // call needs the matching shape. `as []` widens the empty literal
    // appropriately for the once-call.
    vi.mocked(networks).mockReturnValueOnce([] as never);
    const qw = await import("../lib/queryWindows");
    const sel = await import("../lib/selection");
    mockWindowState = { "freenode #italia": "joined" };
    mockMembers = { "freenode #italia": [{ nick: "alice", modes: [] }] };
    render(() => <MembersPane networkSlug="freenode" channelName="#italia" />);
    const btn = document.querySelector(".member-plain .member-name") as HTMLElement;
    fireEvent.click(btn);
    expect(qw.openQueryWindowState).not.toHaveBeenCalled();
    expect(sel.setSelectedChannel).not.toHaveBeenCalled();
  });

  // Bucket F H1 — own-nick foot-gun regression. When the operator's
  // ACCOUNT NAME (e.g. "vjt") differs from the per-network IRC NICK
  // (e.g. "vjt-grappa" after NickServ ghost recovery), MembersPane's
  // ownModes derivation MUST resolve to the per-network IRC nick — NOT
  // displayNick(me) which returns me.name for users.
  //
  // Pre-fix MembersPane:73 called `displayNick(user())` and looked up
  // ownModes by ACCOUNT name. If a peer happened to be using the
  // operator's account name as their IRC nick on this network (which is
  // NOT the operator), the lookup would falsely return that peer's
  // modes → UserContextMenu would render op-gated items as enabled when
  // the operator does NOT actually hold @ on this channel, allowing the
  // operator to issue ops actions that always 401 from the upstream
  // server.
  //
  // Asserts the post-fix behavior: ownModes resolves to the row whose
  // nick matches the per-network IRC nick (network.nick) — NOT
  // user.name.
  it("derives ownModes from per-network IRC nick, not from account name (H1)", async () => {
    const { networks } = await import("../lib/networks");
    // Operator runs on freenode under IRC nick "vjt-grappa" but account
    // name is "vjt". A peer named "vjt" holds @ on this channel.
    vi.mocked(networks).mockReturnValue([
      {
        id: 1,
        slug: "freenode",
        nick: "vjt-grappa",
        connection_state: "connected",
        inserted_at: "x",
        updated_at: "y",
      },
    ] as never);
    mockWindowState = { "freenode #italia": "joined" };
    mockMembers = {
      "freenode #italia": [
        // Peer using account-name "vjt" as IRC nick — has @ on this channel.
        // If MembersPane resolved ownModes by account name it would falsely
        // pick this row and treat the operator as an op.
        { nick: "vjt", modes: ["@"] },
        // The OPERATOR's actual row on this network: IRC nick = "vjt-grappa",
        // plain (no modes). UserContextMenu should disable op-gated items.
        { nick: "vjt-grappa", modes: [] },
      ],
    };

    // Capture the ownModes the menu receives by replacing the
    // UserContextMenu mock with one that records its props.
    const recorded: { ownModes?: string[] } = {};
    vi.doMock("../UserContextMenu", () => ({
      default: (props: { ownModes: string[] }) => {
        recorded.ownModes = props.ownModes;
        return <div data-testid="context-menu-stub" />;
      },
    }));
    // Re-import MembersPane so it picks up the doMock'd UserContextMenu.
    vi.resetModules();
    const { default: FreshMembersPane } = await import("../MembersPane");

    render(() => <FreshMembersPane networkSlug="freenode" channelName="#italia" />);
    // Right-click any row to open the context menu and trigger ownModes derivation.
    const peerBtn = document.querySelector(".member-op .member-name") as HTMLElement;
    fireEvent.contextMenu(peerBtn);

    // Post-fix: ownModes is the OPERATOR's modes ([]), NOT the peer's (@).
    // Pre-fix this would be ["@"] because lookup keyed on account name "vjt".
    expect(recorded.ownModes).toEqual([]);

    vi.doUnmock("../UserContextMenu");
  });

  // Bucket J (2026-05-19) — render order is op > halfop > voice > plain,
  // alpha within tier (case-insensitive per RFC 2812 §2.2). Source of
  // truth for the rule is `sortMembers` in lib/members.ts; MembersPane
  // calls it inside a createMemo. These tests assert the rule is wired
  // at the render boundary — `members.test.ts` covers the sort kernel.
  it("renders members in tier order: op > halfop > voice > plain (bucket J)", () => {
    mockWindowState = { "freenode #italia": "joined" };
    // Inject in deliberately-wrong arrival order — sort must rescue.
    mockMembers = {
      "freenode #italia": [
        { nick: "plain", modes: [] },
        { nick: "voice", modes: ["+"] },
        { nick: "op", modes: ["@"] },
        { nick: "halfop", modes: ["%"] },
      ],
    };
    render(() => <MembersPane networkSlug="freenode" channelName="#italia" />);
    const buttons = Array.from(document.querySelectorAll(".member-name"));
    expect(buttons.map((b) => (b.textContent || "").trim())).toEqual([
      "@op",
      "%halfop",
      "+voice",
      "plain",
    ]);
  });

  it("alpha-sorts within each tier (case-insensitive — bucket J)", () => {
    mockWindowState = { "freenode #italia": "joined" };
    mockMembers = {
      "freenode #italia": [
        { nick: "Zoe", modes: ["@"] },
        { nick: "alice", modes: ["@"] },
        { nick: "Bob", modes: ["@"] },
      ],
    };
    render(() => <MembersPane networkSlug="freenode" channelName="#italia" />);
    const buttons = Array.from(document.querySelectorAll(".member-name"));
    expect(buttons.map((b) => (b.textContent || "").trim())).toEqual(["@alice", "@Bob", "@Zoe"]);
  });

  it("renders halfops with .member-halfop class and % sigil (bucket J)", () => {
    mockWindowState = { "freenode #italia": "joined" };
    mockMembers = {
      "freenode #italia": [{ nick: "carol", modes: ["%"] }],
    };
    render(() => <MembersPane networkSlug="freenode" channelName="#italia" />);
    const halfop = document.querySelector(".member-halfop");
    expect(halfop?.textContent).toContain("%carol");
  });
});
