import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import type { VhostSettingsView } from "../lib/userSettings";
import VhostSettingsPage from "../VhostSettingsPage";

// #252 — the vhost settings SUB-PAGE. Pure presentational component: the
// server owns the allow-set + selection; this widget buckets the options
// into three tap-select sections, renders each by its resolved NAME (with
// the /128 as a muted subline), and reports selection changes up via
// `onSetSelection` (the drawer PUTs). No network here — props only.

type Opt = VhostSettingsView["available"][number];

const opt = (over: Partial<Opt> & { address: string }): Opt => ({
  in_pool: false,
  granted: false,
  name: over.address,
  ...over,
});

const view = (over: Partial<VhostSettingsView> = {}): VhostSettingsView => ({
  available: [],
  selection: [],
  ...over,
});

const renderPage = (
  v: VhostSettingsView | null,
  opts: {
    error?: string | null;
    onSetSelection?: (a: string[]) => void;
    onBack?: () => void;
    onReconnect?: () => void;
    reconnecting?: boolean;
    reconnectError?: string | null;
  } = {},
) =>
  render(() => (
    <VhostSettingsPage
      view={v}
      error={opts.error ?? null}
      onSetSelection={opts.onSetSelection ?? vi.fn()}
      onBack={opts.onBack ?? vi.fn()}
      onReconnect={opts.onReconnect ?? vi.fn()}
      reconnecting={opts.reconnecting ?? false}
      reconnectError={opts.reconnectError ?? null}
    />
  ));

describe("VhostSettingsPage — chrome", () => {
  it("renders a back button that fires onBack", () => {
    const onBack = vi.fn();
    renderPage(view(), { onBack });
    fireEvent.click(screen.getByTestId("vhost-back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("shows the error message when error is set", () => {
    renderPage(view(), { error: "forbidden_vhost" });
    expect(screen.getByTestId("vhost-error")).toHaveTextContent("forbidden_vhost");
  });
});

describe("VhostSettingsPage — #282 reconnect footer", () => {
  it("renders an always-available Reconnect button (no pending-gate, even with an empty view)", () => {
    // Empty view = no change; the button is STILL available (D2: reconnect is
    // on-demand, never gated on pending-detection).
    renderPage(view());
    const btn = screen.getByTestId("vhost-reconnect") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn).toHaveTextContent(/reconnect to apply/i);
  });

  it("stays available with a customized selection", () => {
    renderPage(
      view({
        available: [opt({ address: "2001:db8::1", in_pool: true })],
        selection: ["2001:db8::1"],
      }),
    );
    expect((screen.getByTestId("vhost-reconnect") as HTMLButtonElement).disabled).toBe(false);
  });

  it("arms on the first tap and fires onReconnect ONLY on the confirm (second) tap", () => {
    const onReconnect = vi.fn();
    renderPage(view(), { onReconnect });
    const btn = screen.getByTestId("vhost-reconnect");
    // First tap → arm (confirm label), no reconnect yet — a single stray tap
    // never bounces every network.
    fireEvent.click(btn);
    expect(onReconnect).not.toHaveBeenCalled();
    expect(btn).toHaveTextContent(/reconnect now/i);
    // Second tap → confirm → reconnect fires exactly once.
    fireEvent.click(btn);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("returns to the idle label after confirming (the arm resets)", () => {
    renderPage(view());
    const btn = screen.getByTestId("vhost-reconnect");
    fireEvent.click(btn); // arm
    fireEvent.click(btn); // confirm
    expect(btn).toHaveTextContent(/reconnect to apply/i);
  });

  it("relabels the idle button to Reconnecting… while a reconnect is in flight", () => {
    renderPage(view(), { reconnecting: true });
    expect(screen.getByTestId("vhost-reconnect")).toHaveTextContent(/reconnecting/i);
  });

  it("surfaces a reconnect error inline", () => {
    renderPage(view(), { reconnectError: "network_circuit_open" });
    expect(screen.getByTestId("vhost-reconnect-error")).toHaveTextContent("network_circuit_open");
  });
});

describe("VhostSettingsPage — customize toggle (default OFF = random)", () => {
  it("with an empty selection: toggle is OFF, random message shown, pool listed read-only, no sections", () => {
    renderPage(
      view({
        available: [opt({ address: "2001:db8::1", in_pool: true, name: "pool-one.cloak" })],
        selection: [],
      }),
    );
    const toggle = screen.getByTestId("vhost-customize-toggle") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByTestId("vhost-random-msg")).toBeInTheDocument();
    // The pool is shown read-only (its name) when customize is OFF.
    expect(screen.getByTestId("vhost-pool-readonly")).toHaveTextContent("pool-one.cloak");
    // No tap-select sections while OFF.
    expect(screen.queryByTestId("vhost-section-in-pool")).toBeNull();
  });

  it("clicking the toggle ON reveals the sections (even with an empty selection)", () => {
    renderPage(
      view({
        available: [opt({ address: "2001:db8::1", in_pool: true })],
        selection: [],
      }),
    );
    fireEvent.click(screen.getByTestId("vhost-customize-toggle"));
    expect(screen.getByTestId("vhost-section-in-pool")).toBeInTheDocument();
    expect(screen.queryByTestId("vhost-random-msg")).toBeNull();
  });

  it("with a non-empty selection: toggle starts ON and sections are visible on mount", () => {
    renderPage(
      view({
        available: [opt({ address: "2001:db8::1", in_pool: true })],
        selection: ["2001:db8::1"],
      }),
    );
    const toggle = screen.getByTestId("vhost-customize-toggle") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(screen.getByTestId("vhost-section-in-pool")).toBeInTheDocument();
  });

  it("turning the toggle OFF resets the selection to [] (PUT empty)", () => {
    const onSetSelection = vi.fn();
    renderPage(
      view({
        available: [opt({ address: "2001:db8::1", in_pool: true })],
        selection: ["2001:db8::1"],
      }),
      { onSetSelection },
    );
    // Starts ON (non-empty selection). Click → OFF.
    fireEvent.click(screen.getByTestId("vhost-customize-toggle"));
    expect(onSetSelection).toHaveBeenCalledWith([]);
  });
});

describe("VhostSettingsPage — three sections + bucketing (customize ON)", () => {
  const threeBuckets = view({
    available: [
      opt({ address: "2001:db8::e", granted: true, name: "exclusive.cloak" }),
      opt({ address: "2001:db8::p", in_pool: true, name: "inpool.cloak" }),
      opt({ address: "2001:db8::o", name: "outpool.cloak" }),
    ],
    // non-empty selection → starts ON, all sections visible on mount.
    selection: ["2001:db8::p"],
  });

  it("buckets granted → exclusive, in_pool&&!granted → in pool, else → out of pool", () => {
    renderPage(threeBuckets);
    expect(screen.getByTestId("vhost-section-exclusive")).toHaveTextContent("exclusive.cloak");
    expect(screen.getByTestId("vhost-section-in-pool")).toHaveTextContent("inpool.cloak");
    expect(screen.getByTestId("vhost-section-out-of-pool")).toHaveTextContent("outpool.cloak");
  });

  it("hides the exclusive section when the subject has no grants", () => {
    renderPage(
      view({
        available: [
          opt({ address: "2001:db8::p", in_pool: true }),
          opt({ address: "2001:db8::o" }),
        ],
        selection: ["2001:db8::p"],
      }),
    );
    expect(screen.queryByTestId("vhost-section-exclusive")).toBeNull();
    expect(screen.getByTestId("vhost-section-in-pool")).toBeInTheDocument();
  });

  it("a granted option in_pool lands ONLY in exclusive, not double-counted in in-pool", () => {
    renderPage(
      view({
        available: [opt({ address: "2001:db8::g", in_pool: true, granted: true, name: "g.cloak" })],
        selection: ["2001:db8::g"],
      }),
    );
    expect(screen.getByTestId("vhost-section-exclusive")).toHaveTextContent("g.cloak");
    expect(screen.queryByTestId("vhost-section-in-pool")).toBeNull();
  });
});

describe("VhostSettingsPage — NAME-primary render", () => {
  it("shows the name as the primary label and the /128 as a muted subline", () => {
    renderPage(
      view({
        available: [opt({ address: "2001:db8::1", in_pool: true, name: "vanity.cloak.example" })],
        selection: ["2001:db8::1"],
      }),
    );
    const btn = screen.getByTestId("vhost-option-2001:db8::1");
    expect(btn.querySelector(".mode-modal-toggle-label")).toHaveTextContent("vanity.cloak.example");
    expect(btn.querySelector(".mode-modal-toggle-desc")).toHaveTextContent("2001:db8::1");
  });

  it("omits the muted subline when the name is just the raw IP (no PTR / cold)", () => {
    renderPage(
      view({
        available: [opt({ address: "2001:db8::1", in_pool: true, name: "2001:db8::1" })],
        selection: ["2001:db8::1"],
      }),
    );
    const btn = screen.getByTestId("vhost-option-2001:db8::1");
    expect(btn.querySelector(".mode-modal-toggle-label")).toHaveTextContent("2001:db8::1");
    expect(btn.querySelector(".mode-modal-toggle-desc")).toBeNull();
  });
});

describe("VhostSettingsPage — tap → selection toggle", () => {
  it("tapping an unselected option adds it to the selection", () => {
    const onSetSelection = vi.fn();
    renderPage(
      view({
        available: [
          opt({ address: "2001:db8::p", in_pool: true }),
          opt({ address: "2001:db8::o" }),
        ],
        selection: ["2001:db8::p"],
      }),
      { onSetSelection },
    );
    fireEvent.click(screen.getByTestId("vhost-option-2001:db8::o"));
    expect(onSetSelection).toHaveBeenCalledWith(["2001:db8::p", "2001:db8::o"]);
  });

  it("tapping a selected option removes it from the selection", () => {
    const onSetSelection = vi.fn();
    renderPage(
      view({
        available: [opt({ address: "2001:db8::p", in_pool: true })],
        selection: ["2001:db8::p"],
      }),
      { onSetSelection },
    );
    fireEvent.click(screen.getByTestId("vhost-option-2001:db8::p"));
    expect(onSetSelection).toHaveBeenCalledWith([]);
  });

  it("a selected option reflects aria-pressed + the active class", () => {
    renderPage(
      view({
        available: [opt({ address: "2001:db8::p", in_pool: true })],
        selection: ["2001:db8::p"],
      }),
    );
    const btn = screen.getByTestId("vhost-option-2001:db8::p");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.classList.contains("mode-modal-toggle-active")).toBe(true);
  });
});
