import { fireEvent, render, screen } from "@solidjs/testing-library";
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
  sender_nick: "alice",
  body: "hey vjt, you around?",
  kind: "privmsg",
} as const;

const MSG1 = {
  server_time: 1_746_442_201_000,
  channel: "#irc",
  sender_nick: "bob",
  body: "vjt are you back",
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
  it("renders header with count and away interval", () => {
    render(() => <MentionsWindow bundle={makeBundle()} ownNick="vjt" onMentionClicked={vi.fn()} />);

    const header = screen.getByTestId("mentions-header");
    expect(header.textContent).toContain("2 mentions");
    expect(header.textContent).toContain("lunch");
  });

  it("renders singular 'mention' when count is 1", () => {
    const bundle = makeBundle({ messages: [MSG0] });
    render(() => <MentionsWindow bundle={bundle} ownNick="vjt" onMentionClicked={vi.fn()} />);

    const header = screen.getByTestId("mentions-header");
    expect(header.textContent).toContain("1 mention");
    expect(header.textContent).not.toContain("mentions ");
  });

  it("renders one row per message", () => {
    render(() => <MentionsWindow bundle={makeBundle()} ownNick="vjt" onMentionClicked={vi.fn()} />);

    const rows = screen.getAllByTestId("mentions-row");
    expect(rows).toHaveLength(2);
  });

  it("each row shows channel + sender + body", () => {
    render(() => <MentionsWindow bundle={makeBundle()} ownNick="vjt" onMentionClicked={vi.fn()} />);

    const rows = screen.getAllByTestId("mentions-row");
    const firstRow = rows[0];
    expect(firstRow).toBeDefined();
    expect(firstRow?.textContent).toContain("#grappa");
    expect(firstRow?.textContent).toContain("alice");
    expect(firstRow?.textContent).toContain("hey vjt, you around?");
  });

  it("row click invokes onMentionClicked with correct args", () => {
    const onClicked = vi.fn<(args: MentionClickedArgs) => void>();

    render(() => (
      <MentionsWindow bundle={makeBundle()} ownNick="vjt" onMentionClicked={onClicked} />
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

  it("second row click invokes onMentionClicked with second row args", () => {
    const onClicked = vi.fn<(args: MentionClickedArgs) => void>();

    render(() => (
      <MentionsWindow bundle={makeBundle()} ownNick="vjt" onMentionClicked={onClicked} />
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
    render(() => <MentionsWindow bundle={makeBundle()} ownNick="vjt" onMentionClicked={vi.fn()} />);

    const rows = screen.getAllByTestId("mentions-row");
    // Both rows contain "vjt" in body per makeBundle fixture.
    expect(rows[0]?.classList.contains("scrollback-highlight")).toBe(true);
    expect(rows[1]?.classList.contains("scrollback-highlight")).toBe(true);
  });

  it("does not highlight when ownNick is null", () => {
    render(() => (
      <MentionsWindow bundle={makeBundle()} ownNick={null} onMentionClicked={vi.fn()} />
    ));

    const rows = screen.getAllByTestId("mentions-row");
    expect(rows[0]?.classList.contains("scrollback-highlight")).toBe(false);
  });

  it("renders without away_reason when reason is null", () => {
    const bundle = makeBundle({ away_reason: null });
    render(() => <MentionsWindow bundle={bundle} ownNick="vjt" onMentionClicked={vi.fn()} />);

    const header = screen.getByTestId("mentions-header");
    expect(header.textContent).not.toContain("·");
  });
});
