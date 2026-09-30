import { fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MentionsWindow, { type MentionClickedArgs, type MentionsBundle } from "../MentionsWindow";

// #370 — the keyword-highlight list, signal-backed so a test can stage
// custom patterns. Default empty so the own-nick tests below are unaffected.
const [highlightPatternsSig, setHighlightPatternsForTest] = createSignal<string[]>([]);
vi.mock("../lib/highlightList", () => ({
  highlightPatterns: () => highlightPatternsSig(),
}));

// #370 — MentionsWindow uses the REAL `matchesWatchlist` (pure, jsdom-safe),
// matching the sibling ScrollbackPane.test; only the keyword-list store is
// mocked. So these assertions exercise the actual word-boundary predicate.
beforeEach(() => {
  setHighlightPatternsForTest([]);
});

const MSG0 = {
  id: 101,
  server_time: 1_746_442_200_000,
  channel: "#grappa",
  dm_with: null,
  sender: "alice",
  body: "hey vjt, you around?",
  kind: "privmsg",
} as const;

const MSG1 = {
  id: 102,
  server_time: 1_746_442_201_000,
  channel: "#irc",
  dm_with: null,
  sender: "bob",
  body: "vjt are you back",
  kind: "privmsg",
} as const;

// Same channel as MSG0 — used to prove per-channel grouping clusters
// multiple rows under ONE channel label (#188 item 2).
const MSG0B = {
  id: 103,
  server_time: 1_746_442_202_000,
  channel: "#grappa",
  dm_with: null,
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
        railOpener={null}
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
      <MentionsWindow
        bundle={bundle}
        ownNick="vjt"
        onMentionClicked={vi.fn()}
        onClose={vi.fn()}
        railOpener={null}
      />
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
        railOpener={null}
      />
    ));
    expect(screen.getByTestId("mentions-header").textContent).toContain("lunch");
  });

  it("renders without away_reason when reason is null", () => {
    const bundle = makeBundle({ away_reason: null });
    render(() => (
      <MentionsWindow
        bundle={bundle}
        ownNick="vjt"
        onMentionClicked={vi.fn()}
        onClose={vi.fn()}
        railOpener={null}
      />
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
        railOpener={null}
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
      <MentionsWindow
        bundle={bundle}
        ownNick="vjt"
        onMentionClicked={vi.fn()}
        onClose={vi.fn()}
        railOpener={null}
      />
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
        railOpener={null}
      />
    ));

    const rows = screen.getAllByTestId("mentions-row");
    const firstRow = rows[0];
    expect(firstRow).toBeDefined();
    expect(firstRow?.textContent).toContain("alice");
    expect(firstRow?.textContent).toContain("hey vjt, you around?");
  });

  it("row click hands Shell the window and the message to land on", () => {
    const onClicked = vi.fn<(args: MentionClickedArgs) => void>();

    render(() => (
      <MentionsWindow
        bundle={makeBundle()}
        ownNick="vjt"
        onMentionClicked={onClicked}
        onClose={vi.fn()}
        railOpener={null}
      />
    ));

    const rows = screen.getAllByTestId("mentions-row");
    const firstRow = rows[0];
    expect(firstRow).toBeDefined();
    if (firstRow) fireEvent.click(firstRow);

    expect(onClicked).toHaveBeenCalledTimes(1);
    expect(onClicked).toHaveBeenCalledWith({
      networkSlug: "freenode",
      window: "#grappa",
      kind: "channel",
      messageId: 101,
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
        railOpener={null}
      />
    ));

    const rows = screen.getAllByTestId("mentions-row");
    const secondRow = rows[1];
    expect(secondRow).toBeDefined();
    if (secondRow) fireEvent.click(secondRow);

    expect(onClicked).toHaveBeenCalledWith({
      networkSlug: "freenode",
      window: "#irc",
      kind: "channel",
      messageId: 102,
    });
  });

  // issue 2333 — an inbound DM is stored at `channel = <own nick>`. Filed
  // under `channel` it would be labelled with our own nick and the tap would
  // open the self window, where the row is not shown. `dm_with` names the
  // peer's window.
  it("files an inbound DM mention under the peer, and taps into the peer's query", () => {
    const onClicked = vi.fn<(args: MentionClickedArgs) => void>();
    const dm = {
      id: 104,
      server_time: 1_746_442_203_000,
      channel: "vjt",
      dm_with: "Alice",
      sender: "Alice",
      body: "vjt: psst",
      kind: "privmsg",
    } as const;

    render(() => (
      <MentionsWindow
        bundle={makeBundle({ messages: [dm] })}
        ownNick="vjt"
        onMentionClicked={onClicked}
        onClose={vi.fn()}
        railOpener={null}
      />
    ));

    expect(screen.getByTestId("mentions-group-channel").textContent).toBe("Alice");
    fireEvent.click(screen.getByTestId("mentions-row"));
    expect(onClicked).toHaveBeenCalledWith({
      networkSlug: "freenode",
      window: "Alice",
      kind: "query",
      messageId: 104,
    });
  });

  // A server predating protocol 35 sends neither key. The tap still switches
  // to the window — what it did before issue 2333 — and asks for no scroll.
  it("taps without a message to land on when the server predates the id", () => {
    const onClicked = vi.fn<(args: MentionClickedArgs) => void>();
    const { id: _id, dm_with: _dm, ...legacy } = MSG0;

    render(() => (
      <MentionsWindow
        bundle={makeBundle({ messages: [legacy] })}
        ownNick="vjt"
        onMentionClicked={onClicked}
        onClose={vi.fn()}
        railOpener={null}
      />
    ));

    fireEvent.click(screen.getByTestId("mentions-row"));
    expect(onClicked).toHaveBeenCalledWith({
      networkSlug: "freenode",
      window: "#grappa",
      kind: "channel",
      messageId: null,
    });
  });

  it("highlights rows where body matches ownNick", () => {
    render(() => (
      <MentionsWindow
        bundle={makeBundle()}
        ownNick="vjt"
        onMentionClicked={vi.fn()}
        onClose={vi.fn()}
        railOpener={null}
      />
    ));

    const rows = screen.getAllByTestId("mentions-row");
    // Both rows contain "vjt" in body per makeBundle fixture.
    expect(rows[0]?.classList.contains("scrollback-highlight")).toBe(true);
    expect(rows[1]?.classList.contains("scrollback-highlight")).toBe(true);
  });

  it("highlights a row matching a CUSTOM highlight word even without the own nick (#370)", () => {
    setHighlightPatternsForTest(["deploy"]);
    const bundle = makeBundle({ messages: [{ ...MSG0, body: "the deploy is done" }] });
    render(() => (
      <MentionsWindow
        bundle={bundle}
        ownNick="vjt"
        onMentionClicked={vi.fn()}
        onClose={vi.fn()}
        railOpener={null}
      />
    ));

    const rows = screen.getAllByTestId("mentions-row");
    // Body carries no own nick — the highlight is driven by the /hilight word.
    expect(rows[0]?.classList.contains("scrollback-highlight")).toBe(true);
  });

  // issue 1481 — the render port's third site. The bundle itself no longer
  // carries own rows (the server-side `mention_row?/3` drops them), but the
  // class is decided here, so the guard has to hold on the row it is handed.
  it("does not highlight a row the operator authored", () => {
    const bundle = makeBundle({ messages: [{ ...MSG0, sender: "vjt", body: "vjt: prova" }] });
    render(() => (
      <MentionsWindow
        bundle={bundle}
        ownNick="vjt"
        onMentionClicked={vi.fn()}
        onClose={vi.fn()}
        railOpener={null}
      />
    ));

    const rows = screen.getAllByTestId("mentions-row");
    expect(rows[0]?.classList.contains("scrollback-highlight")).toBe(false);
  });

  it("still highlights the SAME body from a peer (issue 1481 control)", () => {
    const bundle = makeBundle({ messages: [{ ...MSG0, sender: "alice", body: "vjt: prova" }] });
    render(() => (
      <MentionsWindow
        bundle={bundle}
        ownNick="vjt"
        onMentionClicked={vi.fn()}
        onClose={vi.fn()}
        railOpener={null}
      />
    ));

    const rows = screen.getAllByTestId("mentions-row");
    expect(rows[0]?.classList.contains("scrollback-highlight")).toBe(true);
  });

  it("does not highlight when ownNick is null", () => {
    render(() => (
      <MentionsWindow
        bundle={makeBundle()}
        ownNick={null}
        onMentionClicked={vi.fn()}
        onClose={vi.fn()}
        railOpener={null}
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
        railOpener={null}
      />
    ));

    fireEvent.click(screen.getByTestId("mentions-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // #220 — a mention body is another tappable surface wrapping MircBody:
  // tapping a LINK in the body must just browse (open the URL), NOT jump
  // to the source message (onMentionClicked). Same "link-wins" policy as
  // the /list directory row. Without it, a mention like "see
  // https://x/y" double-fires: browse AND jump.
  it("clicking a link inside a mention body does NOT invoke onMentionClicked (#220)", () => {
    const onClicked = vi.fn<(args: MentionClickedArgs) => void>();
    const bundle = makeBundle({
      messages: [{ ...MSG0, body: "docs at https://example.com/x here" }],
    });

    const { container } = render(() => (
      <MentionsWindow
        bundle={bundle}
        ownNick="vjt"
        onMentionClicked={onClicked}
        onClose={vi.fn()}
        railOpener={null}
      />
    ));

    const link = container.querySelector(".scrollback-link") as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.href).toBe("https://example.com/x");

    // Real bubbling click on the anchor. If it failed to stopPropagation,
    // it would reach the row button's onMentionClicked.
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(ev);

    expect(onClicked).not.toHaveBeenCalled();
    // The link is free to navigate — nothing prevents its default.
    expect(ev.defaultPrevented).toBe(false);
  });
  // issue 2333 — the rail door slot renders between the heading and the ✕, and
  // `null` renders nothing: the header's own children are unchanged.
  it("renders the railOpener slot before the close ✕, and nothing for null", () => {
    const { unmount } = render(() => (
      <MentionsWindow
        bundle={makeBundle()}
        ownNick="vjt"
        onMentionClicked={vi.fn()}
        onClose={vi.fn()}
        railOpener={<button type="button" data-testid="slot-door" />}
      />
    ));
    const door = screen.getByTestId("slot-door");
    expect(door.nextElementSibling?.getAttribute("data-testid")).toBe("mentions-close");
    unmount();

    render(() => (
      <MentionsWindow
        bundle={makeBundle()}
        ownNick="vjt"
        onMentionClicked={vi.fn()}
        onClose={vi.fn()}
        railOpener={null}
      />
    ));
    const main = screen.getByTestId("mentions-close").parentElement;
    expect(main?.children.length).toBe(2);
  });
});
