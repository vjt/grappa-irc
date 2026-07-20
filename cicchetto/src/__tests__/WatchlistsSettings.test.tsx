import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #356 — the unified watch-lists settings sub-page. Self-contained: reads
// the notifyWatch + highlightList module stores directly and calls the REST
// / socket helpers on mutation. Mock those boundaries; assert the VISIBLE
// outcome (both lists render, × removes, add-form adds through the API).

const postNotifyAddMock = vi.fn().mockResolvedValue(undefined);
const deleteNotifyNickMock = vi.fn().mockResolvedValue(undefined);
const addHighlightMock = vi.fn().mockResolvedValue(["foo", "bar"]);
const delHighlightMock = vi.fn().mockResolvedValue([]);
const refreshHighlightsMock = vi.fn().mockResolvedValue(["foo"]);

let networksData: Array<{ kind: string; id: number; slug: string; nick: string }> = [];
let watchData: Record<number, Array<{ network_id: number; nick: string; added_at: string }>> = {};
let highlightData: string[] = [];

vi.mock("../lib/api", () => ({
  postNotifyAdd: (t: string, slug: string, nicks: string[]) => postNotifyAddMock(t, slug, nicks),
  deleteNotifyNick: (t: string, slug: string, nick: string) => deleteNotifyNickMock(t, slug, nick),
}));

vi.mock("../lib/auth", () => ({ token: () => "tok" }));

vi.mock("../lib/networks", () => ({ networks: () => networksData }));

vi.mock("../lib/notifyWatch", () => ({
  watchByNetwork: () => watchData,
  presenceFor: (_id: number, nick: string) => (nick === "gigi" ? "online" : "unknown"),
}));

vi.mock("../lib/highlightList", () => ({
  highlightPatterns: () => highlightData,
  addHighlight: (p: string) => addHighlightMock(p),
  delHighlight: (p: string) => delHighlightMock(p),
  refreshHighlights: () => refreshHighlightsMock(),
}));

// NickText is a pure display component; stub it to a plain span so this
// test stays isolated from its (broad) transitive imports.
vi.mock("../NickText", () => ({
  default: (props: { nick: string }) => <span data-testid="nick">{props.nick}</span>,
}));

import WatchlistsSettings from "../WatchlistsSettings";

beforeEach(() => {
  vi.clearAllMocks();
  networksData = [{ kind: "user", id: 1, slug: "freenode", nick: "vjt" }];
  watchData = { 1: [{ network_id: 1, nick: "gigi", added_at: "" }] };
  highlightData = ["foo"];
});

describe("WatchlistsSettings (#356)", () => {
  it("renders ONE 'watch lists' sub-page holding BOTH sections under it", () => {
    render(() => <WatchlistsSettings onBack={() => {}} />);
    expect(screen.getByTestId("watchlists-subpage")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /watch lists/i })).toBeInTheDocument();
    // Both lists live in the same sub-page.
    expect(screen.getByTestId("watchlists-section-notify")).toBeInTheDocument();
    expect(screen.getByTestId("watchlists-section-highlight")).toBeInTheDocument();
  });

  it("‹ back fires onBack", () => {
    const onBack = vi.fn();
    render(() => <WatchlistsSettings onBack={onBack} />);
    fireEvent.click(screen.getByTestId("watchlists-back"));
    expect(onBack).toHaveBeenCalled();
  });

  it("refreshes the keyword list on mount (no broadcast, must fetch)", () => {
    render(() => <WatchlistsSettings onBack={() => {}} />);
    expect(refreshHighlightsMock).toHaveBeenCalled();
  });

  it("presence: shows the per-network watched nick + × removes via the SAME REST surface", () => {
    render(() => <WatchlistsSettings onBack={() => {}} />);
    // The freenode block shows the watched nick.
    expect(screen.getByTestId("watchlists-notify-freenode")).toBeInTheDocument();
    expect(screen.getByText("gigi")).toBeInTheDocument();
    // × hits deleteNotifyNick(token, slug, nick) — same source of truth as
    // the old home panel + the /notify command.
    fireEvent.click(screen.getByRole("button", { name: /stop watching gigi on freenode/i }));
    expect(deleteNotifyNickMock).toHaveBeenCalledWith("tok", "freenode", "gigi");
  });

  it("presence: the per-network add-form posts the nick to that network", () => {
    render(() => <WatchlistsSettings onBack={() => {}} />);
    const input = screen.getByTestId("watchlists-notify-add-freenode") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "newnick" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(postNotifyAddMock).toHaveBeenCalledWith("tok", "freenode", ["newnick"]);
  });

  it("keyword: shows a pattern + × removes it through the store", () => {
    render(() => <WatchlistsSettings onBack={() => {}} />);
    expect(screen.getByText("foo")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /remove highlight foo/i }));
    expect(delHighlightMock).toHaveBeenCalledWith("foo");
  });

  it("keyword: the add-form adds a pattern through the store", () => {
    render(() => <WatchlistsSettings onBack={() => {}} />);
    const input = screen.getByTestId("watchlists-highlight-add") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "bar" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(addHighlightMock).toHaveBeenCalledWith("bar");
  });

  it("presence: a network with NO entries still offers an add-form", () => {
    watchData = {};
    render(() => <WatchlistsSettings onBack={() => {}} />);
    expect(screen.getByTestId("watchlists-notify-add-freenode")).toBeInTheDocument();
  });
});
