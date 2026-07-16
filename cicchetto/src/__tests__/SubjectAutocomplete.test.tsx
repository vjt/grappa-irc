import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminSubjectSearchResult } from "../lib/api";

// #257 — the admin vhost-grant subject autocomplete. Pure label formatting
// is unit-tested here; the debounced search + select wiring is smoke-tested
// in jsdom, and the full UX is proven by the Playwright e2e
// (issue257-vhost-subject-autocomplete.spec.ts) — jsdom is blind to CSS /
// real interaction (feedback_cicchetto_browser_smoke).

vi.mock("../lib/auth", () => ({
  token: () => "test-bearer",
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    adminSearchVhostSubjects: vi.fn(),
  };
});

import SubjectAutocomplete, { formatSubjectLabel } from "../SubjectAutocomplete";

const visitorResult: AdminSubjectSearchResult = {
  type: "visitor",
  id: "v-1",
  network: "azzurra",
  nick: "guest",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("formatSubjectLabel", () => {
  it("shows 'network - nick' for a visitor (disambiguates multi-network)", () => {
    expect(formatSubjectLabel(visitorResult)).toBe("azzurra - guest");
  });

  it("shows 'account - nick' for a user (no fabricated network)", () => {
    expect(formatSubjectLabel({ type: "user", id: "u-1", network: null, nick: "vjt" })).toBe(
      "account - vjt",
    );
  });

  it("falls back to '?' when a visitor row somehow lacks a network", () => {
    expect(formatSubjectLabel({ type: "visitor", id: "v-2", network: null, nick: "x" })).toBe(
      "? - x",
    );
  });
});

describe("SubjectAutocomplete — render + wiring", () => {
  it("renders the search input when there is no selection", () => {
    render(() => (
      <SubjectAutocomplete
        vhostId={3}
        hasSelection={false}
        selectedLabel=""
        onSelect={() => {}}
        onClear={() => {}}
      />
    ));
    expect(screen.getByTestId("subject-autocomplete-input-3")).toBeInTheDocument();
  });

  it("renders the selected chip (not the input) when a subject is selected, and clear fires onClear", () => {
    const onClear = vi.fn();
    render(() => (
      <SubjectAutocomplete
        vhostId={2}
        hasSelection={true}
        selectedLabel="azzurra - guest"
        onSelect={() => {}}
        onClear={onClear}
      />
    ));
    expect(screen.getByTestId("subject-autocomplete-selected-2")).toHaveTextContent(
      "azzurra - guest",
    );
    expect(screen.queryByTestId("subject-autocomplete-input-2")).toBeNull();

    fireEvent.click(screen.getByTestId("subject-autocomplete-clear-2"));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("debounced-searches on input, lists type-tagged results, and calls onSelect on pick", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminSearchVhostSubjects).mockResolvedValue([visitorResult]);
    const onSelect = vi.fn();

    render(() => (
      <SubjectAutocomplete
        vhostId={1}
        hasSelection={false}
        selectedLabel=""
        onSelect={onSelect}
        onClear={() => {}}
      />
    ));

    fireEvent.input(screen.getByTestId("subject-autocomplete-input-1"), {
      target: { value: "gue" },
    });

    const option = await screen.findByTestId("subject-autocomplete-option-1-visitor-v-1");
    expect(option).toHaveTextContent("azzurra - guest");
    expect(vi.mocked(api.adminSearchVhostSubjects)).toHaveBeenCalledWith("test-bearer", "gue");

    fireEvent.click(option);
    expect(onSelect).toHaveBeenCalledWith(visitorResult);
  });
});
