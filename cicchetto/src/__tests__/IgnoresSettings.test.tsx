import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #162 — the ignore-list settings sub-page. Self-contained: reads the
// ignoreList store and calls its verbs on mutation. Mock those boundaries;
// assert the VISIBLE outcome (the masks render per network, × removes
// through the store, the add-form adds through the store, the list is
// refreshed on open because nothing broadcasts it).

const addIgnoreMock = vi.fn().mockResolvedValue({
  masks: [],
  entries: [],
  mask: "x!*@*",
  text_pattern: null,
  outcome: "added",
});
const delIgnoreMock = vi.fn().mockResolvedValue({
  masks: [],
  entries: [],
  mask: "spambot!*@*",
  text_pattern: null,
  outcome: "removed",
});
const refreshIgnoresMock = vi.fn().mockResolvedValue([]);

let networksData: Array<{ kind: string; id: number; slug: string; nick: string }> = [];
let ignoresData: Record<string, Array<{ mask: string; text_pattern: string | null }>> = {};

vi.mock("../lib/auth", () => ({ token: () => "tok" }));

vi.mock("../lib/networks", () => ({
  networkIdBySlug: () => undefined,
  networks: () => networksData,
}));

vi.mock("../lib/ignoreList", () => ({
  ignoresBySlug: () => ignoresData,
  refreshIgnores: (t: string, slug: string) => refreshIgnoresMock(t, slug),
  addIgnore: (t: string, slug: string, mask: string, text: string | null) =>
    addIgnoreMock(t, slug, mask, text),
  delIgnore: (t: string, slug: string, mask: string, text: string | null) =>
    delIgnoreMock(t, slug, mask, text),
}));

import IgnoresSettings from "../IgnoresSettings";
import { ApiError } from "../lib/api";

beforeEach(() => {
  vi.clearAllMocks();
  networksData = [
    { kind: "user", id: 1, slug: "freenode", nick: "vjt" },
    { kind: "user", id: 2, slug: "ircnet", nick: "vjt" },
  ];
  ignoresData = {
    freenode: [
      { mask: "spambot!*@*", text_pattern: null },
      { mask: "*!*@*.evil.example", text_pattern: null },
      { mask: "relay!*@*", text_pattern: "<SomeNick>*" },
    ],
  };
});

describe("IgnoresSettings (#162, issue 2294)", () => {
  it("renders the sub-page with one block per network", () => {
    render(() => <IgnoresSettings onBack={() => {}} />);
    expect(screen.getByTestId("ignores-subpage")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /ignore list/i })).toBeInTheDocument();
    expect(screen.getByTestId("ignores-network-freenode")).toBeInTheDocument();
    expect(screen.getByTestId("ignores-network-ircnet")).toBeInTheDocument();
  });

  it("‹ back fires onBack", () => {
    const onBack = vi.fn();
    render(() => <IgnoresSettings onBack={onBack} />);
    fireEvent.click(screen.getByTestId("ignores-back"));
    expect(onBack).toHaveBeenCalled();
  });

  it("refreshes every network's list on mount (no broadcast, must fetch)", () => {
    render(() => <IgnoresSettings onBack={() => {}} />);
    expect(refreshIgnoresMock).toHaveBeenCalledWith("tok", "freenode");
    expect(refreshIgnoresMock).toHaveBeenCalledWith("tok", "ircnet");
  });

  it("shows the entries of a network and × removes through the store, by network", () => {
    render(() => <IgnoresSettings onBack={() => {}} />);
    expect(screen.getByText("spambot!*@*")).toBeInTheDocument();
    expect(screen.getByText("*!*@*.evil.example")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /stop ignoring spambot!\*@\* on freenode/i }),
    );
    expect(delIgnoreMock).toHaveBeenCalledWith("tok", "freenode", "spambot!*@*", null);
  });

  // issue 2294 — the row names BOTH halves, and the × removes the PAIR. A ×
  // that sent the mask alone would delete a rule the operator never pointed
  // at (or nothing at all), which is the whole reason identity is the pair.
  it("an entry with a text pattern renders both halves and × removes the PAIR", () => {
    render(() => <IgnoresSettings onBack={() => {}} />);
    expect(screen.getByText("relay!*@* matching <SomeNick>*")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: /stop ignoring relay!\*@\* matching <SomeNick>\* on freenode/i,
      }),
    );
    expect(delIgnoreMock).toHaveBeenCalledWith("tok", "freenode", "relay!*@*", "<SomeNick>*");
  });

  it("the per-network add-form adds through the store, scoped to that network", () => {
    render(() => <IgnoresSettings onBack={() => {}} />);
    const input = screen.getByTestId("ignores-add-ircnet") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "troll" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(addIgnoreMock).toHaveBeenCalledWith("tok", "ircnet", "troll", null);
  });

  it("the optional pattern input rides the same add", () => {
    render(() => <IgnoresSettings onBack={() => {}} />);
    const mask = screen.getByTestId("ignores-add-ircnet") as HTMLInputElement;
    const pattern = screen.getByTestId("ignores-add-pattern-ircnet") as HTMLInputElement;
    fireEvent.input(mask, { target: { value: "relay" } });
    fireEvent.input(pattern, { target: { value: "<A> *" } });
    fireEvent.submit(mask.closest("form") as HTMLFormElement);
    expect(addIgnoreMock).toHaveBeenCalledWith("tok", "ircnet", "relay", "<A> *");
  });

  it("a blank pattern input is NO pattern, not an empty one the server would refuse", () => {
    render(() => <IgnoresSettings onBack={() => {}} />);
    const mask = screen.getByTestId("ignores-add-ircnet") as HTMLInputElement;
    const pattern = screen.getByTestId("ignores-add-pattern-ircnet") as HTMLInputElement;
    fireEvent.input(mask, { target: { value: "relay" } });
    fireEvent.input(pattern, { target: { value: "   " } });
    fireEvent.submit(mask.closest("form") as HTMLFormElement);
    expect(addIgnoreMock).toHaveBeenCalledWith("tok", "ircnet", "relay", null);
  });

  it("a network with nothing ignored says so and still offers the add-form", () => {
    render(() => <IgnoresSettings onBack={() => {}} />);
    expect(screen.getByText(/nothing ignored on ircnet/)).toBeInTheDocument();
    expect(screen.getByTestId("ignores-add-ircnet")).toBeInTheDocument();
    expect(screen.queryByTestId("ignores-list-ircnet")).not.toBeInTheDocument();
  });

  it("a rejected mask surfaces the server's reason instead of vanishing", async () => {
    // The 422 the server answers for a bad mask, so the page shows the same
    // friendly line the compose box does.
    addIgnoreMock.mockRejectedValueOnce(new ApiError(422, "invalid_mask"));
    render(() => <IgnoresSettings onBack={() => {}} />);
    const input = screen.getByTestId("ignores-add-freenode") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "a b" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(await screen.findByText(/not valid/)).toBeInTheDocument();
  });
});
