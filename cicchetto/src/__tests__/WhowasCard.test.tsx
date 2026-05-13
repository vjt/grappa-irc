import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { setWhowasBundle } from "../lib/whowasCard";
import WhowasCard from "../WhowasCard";

// P-0c — WHOWAS card component. Render assertions only — wire dispatch
// is covered by userTopic.test.ts.
//
// Test isolation: store accumulates per-network with last-write-wins
// semantics. Each test uses a unique network slug to avoid cross-test
// contamination.

const FULL_BUNDLE = {
  network: "net-full",
  target: "Alice",
  user: "alice_u",
  host: "alice.host",
  realname: "Alice Liddell",
  server: "irc.test.org",
  logoff_time: "Mon May 13 12:34:56 2026",
  not_found: false,
};

describe("WhowasCard", () => {
  it("renders no DOM node when no bundle exists for the network", () => {
    const { container } = render(() => <WhowasCard networkSlug="net-empty" />);
    expect(container.querySelector("[data-testid='whowas-card']")).toBeNull();
  });

  it("renders all fields when bundle is present and not_found: false", () => {
    setWhowasBundle("net-full", FULL_BUNDLE);
    render(() => <WhowasCard networkSlug="net-full" />);
    const card = screen.getByTestId("whowas-card");
    expect(card.textContent).toContain("Alice");
    expect(card.textContent).toContain("alice_u@alice.host");
    expect(card.textContent).toContain("Alice Liddell");
    expect(card.textContent).toContain("irc.test.org");
    expect(card.textContent).toContain("Mon May 13 12:34:56 2026");
  });

  it("renders 'no history' surface when not_found: true", () => {
    setWhowasBundle("net-not-found", {
      network: "net-not-found",
      target: "ghost",
      user: null,
      host: null,
      realname: null,
      server: null,
      logoff_time: null,
      not_found: true,
    });
    render(() => <WhowasCard networkSlug="net-not-found" />);
    const card = screen.getByTestId("whowas-card");
    expect(card.textContent).toContain("ghost");
    expect(card.textContent).toContain("no history");
    // historical fields suppressed
    expect(card.textContent).not.toContain("@");
  });

  it("does not render for a different network", () => {
    setWhowasBundle("net-x", FULL_BUNDLE);
    const { container } = render(() => <WhowasCard networkSlug="net-other" />);
    expect(container.querySelector("[data-testid='whowas-card']")).toBeNull();
  });
});
