import { fireEvent, render, screen, within } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import MentionsWindow, { type MentionClickedArgs, type MentionsBundle } from "../MentionsWindow";

// Mock mentionMatch so highlight logic is exercised without DOM-unfriendly regex.
vi.mock("../lib/mentionMatch", () => ({
  matchesWatchlist: (body: string | null, nick: string | null) => {
    if (!body || !nick) return false;
    return body.toLowerCase().includes(nick.toLowerCase());
  },
  mentionsUser: () => false,
}));

const MSG0 = {
  server_time: 1_746_442_200_000,
  channel: "#grappa",
  sender: "alice",
  body: "hey vjt, you around?",
  kind: "privmsg",
} as const;

const MSG1 = {
  server_time: 1_746_442_201_000,
  channel: "#irc",
  sender: "bob",
  body: "vjt are you back",
  kind: "privmsg",
} as const;

// Same channel as MSG0 — used to prove per-channel grouping clusters
// multiple rows under ONE channel label (#188 item 2).
const MSG0B = {
  server_time: 1_746_442_202_000,
  channel: "#grappa",
  sender: "carol",
  body: "vjt ping",
  kind: "privmsg",
} as const;

const makeBundle = (overrides: Partial<MentionsBundle> = {}): MentionsBundle => ({
  network_slug: "freenode",
  away_started_at: "2026-05-05T10:00:00.000Z",
  away_ended_at: "2026-05-05T10:30:00.000Z",
  away_reason: "lunch",
  messages: [MSG0, MSG1],
  ...overrides,
});

describe("MentionsWindow", () => {
  it("heading leads with the /away phrasing and a message+channel count", () => {
    render(() => (
      <MentionsWindow
        bundle={makeBundle()}
        ownNick="vjt"
        onMentionClicked={vi.fn()}
        onClose={vi.fn()}
      />
    ));

    const header = screen.getByTestId("mentions-header");
    // #188 item 1 — heading text reads "while you were /away" + a count
    // that makes the scope visible before scrolling (N messages in M channels).
    expect(header.textContent).toContain("while you were /away");
    expect(header.textContent).toContain("2 messages in 2 channels");
  });

  it("heading uses singular message/channel wording when count is 1", () => {
    const bundle = makeBundle({ messages: [MSG0] });
    render(() => (
      <MentionsWindow bundle={bundle} ownNick="vjt" onMentionClicked={vi.fn()} onClose={vi.fn()} />
    ));

    const header = screen.getByTestId("mentions-header");
    expect(header.textContent).toContain("1 message in 1 channel");
    // Guard against "1 messages" / "1 channels".
    expect(header.textContent).not.toContain("1 messages");
    expect(header.textContent).not.toContain("1 channels");
  });

  it("keeps the away reason in the header when present", () => {
    render(() => (
      <MentionsWindow
        bundle={makeBundle()}
        ownNick="vjt"
        onMentionClicked={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    expect(screen.getByTestId("mentions-header").textContent).toContain("lunch");
  });

  it("renders without away_reason when reason is null", () => {
    const bundle = makeBundle({ away_reason: null });
    render(() => (
      <MentionsWindow bundle={bundle} ownNick="vjt" onMentionClicked={vi.fn()} onClose={vi.fn()} />
    ));
    expect(screen.getByTestId("mentions-header").textContent).not.toContain("·");
  });

  it("groups rows under a per-channel label (#188 item 2)", () => {
    render(() => (
      <MentionsWindow
        bundle={makeBundle()}
        ownNick="vjt"
        onMentionClicked={vi.fn()}
        onClose={vi.fn()}
      />
    ));

    const groups = screen.getAllByTestId("mentions-group");
    expect(groups).toHaveLength(2);

    const labels = screen.getAllByTestId("mentions-group-channel").map((el) => el.textContent);
    expect(labels).toEqual(["#grappa", "#irc"]);
  });

  it("clusters multiple rows from the same channel under one label", () => {
    const bundle = makeBundle({ messages: [MSG0, MSG0B, MSG1] });
    render(() => (
      <MentionsWindow bundle={bundle} ownNick="vjt" onMentionClicked={vi.fn()} onClose={vi.fn()} />
    ));

    const groups = screen.getAllByTestId("mentions-group");
    expect(groups).toHaveLength(2);
    // First group is #grappa and holds BOTH #grappa rows.
    const firstGroup = groups[0];
    expect(firstGroup).toBeDefined();
    if (!firstGroup) return;
    expect(within(firstGroup).getByTestId("mentions-group-channel").textContent).toBe("#grappa");
    expect(within(firstGroup).getAllByTestId("mentions-row")).toHaveLength(2);
  });

  it("each row shows sender + body (channel lives on the group label)", () => {
    render(() => (
      <MentionsWindow
        bundle={makeBundle()}
        ownNick="vjt"
        onMentionClicked={vi.fn()}
        onClose={vi.fn()}
      />
    ));

    const rows = screen.getAllByTestId("mentions-row");
    const firstRow = rows[0];
    expect(firstRow).toBeDefined();
    expect(firstRow?.textContent).toContain("alice");
    expect(firstRow?.textContent).toContain("hey vjt, you around?");
  });

  it("row click invokes onMentionClicked with the right {networkSlug, channel, serverTime}", () => {
    const onClicked = vi.fn<(args: MentionClickedArgs) => void>();

    render(() => (
      <MentionsWindow
        bundle={makeBundle()}
        ownNick="vjt"
        onMentionClicked={onClicked}
        onClose={vi.fn()}
      />
    ));

    const rows = screen.getAllByTestId("mentions-row");
    const firstRow = rows[0];
    expect(firstRow).toBeDefined();
    if (firstRow) fireEvent.click(firstRow);

    expect(onClicked).toHaveBeenCalledTimes(1);
    expect(onClicked).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channel: "#grappa",
      serverTime: 1_746_442_200_000,
    });
  });

  it("second row click invokes onMentionClicked with the second row's args", () => {
    const onClicked = vi.fn<(args: MentionClickedArgs) => void>();

    render(() => (
      <MentionsWindow
        bundle={makeBundle()}
        ownNick="vjt"
        onMentionClicked={onClicked}
        onClose={vi.fn()}
      />
    ));

    const rows = screen.getAllByTestId("mentions-row");
    const secondRow = rows[1];
    expect(secondRow).toBeDefined();
    if (secondRow) fireEvent.click(secondRow);

    expect(onClicked).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channel: "#irc",
      serverTime: 1_746_442_201_000,
    });
  });

  it("highlights rows where body matches ownNick", () => {
    render(() => (
      <MentionsWindow
        bundle={makeBundle()}
        ownNick="vjt"
        onMentionClicked={vi.fn()}
        onClose={vi.fn()}
      />
    ));

    const rows = screen.getAllByTestId("mentions-row");
    // Both rows contain "vjt" in body per makeBundle fixture.
    expect(rows[0]?.classList.contains("scrollback-highlight")).toBe(true);
    expect(rows[1]?.classList.contains("scrollback-highlight")).toBe(true);
  });

  it("does not highlight when ownNick is null", () => {
    render(() => (
      <MentionsWindow
        bundle={makeBundle()}
        ownNick={null}
        onMentionClicked={vi.fn()}
        onClose={vi.fn()}
      />
    ));

    const rows = screen.getAllByTestId("mentions-row");
    expect(rows[0]?.classList.contains("scrollback-highlight")).toBe(false);
  });

  it("close button invokes onClose (#188 item 5)", () => {
    const onClose = vi.fn();
    render(() => (
      <MentionsWindow
        bundle={makeBundle()}
        ownNick="vjt"
        onMentionClicked={vi.fn()}
        onClose={onClose}
      />
    ));

    fireEvent.click(screen.getByTestId("mentions-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
