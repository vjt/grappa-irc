import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import LusersCard from "../LusersCard";
import { dismissLusersCard, setLusersBundle } from "../lib/lusersBundle";

// P-0d — LUSERS card component. Render assertions only — wire dispatch
// is covered by userTopic.test.ts.
//
// Test isolation: store accumulates per-network with last-write-wins
// semantics. Each test uses a unique network slug to avoid cross-test
// contamination.

const FULL_SNAPSHOT = {
  total_users: 1234,
  invisible: 56,
  servers: 3,
  operators: 7,
  unknown_connections: 2,
  channels_formed: 89,
  local_clients: 100,
  local_servers: 1,
  current_local: 100,
  max_local: 200,
  current_global: 1234,
  max_global: 5000,
};

describe("LusersCard", () => {
  it("renders no DOM node when no snapshot exists for the network", () => {
    const { container } = render(() => <LusersCard networkSlug="net-empty" />);
    expect(container.querySelector("[data-testid='lusers-card']")).toBeNull();
  });

  it("renders all 12 fields when present in the snapshot", () => {
    setLusersBundle("net-full", FULL_SNAPSHOT);
    render(() => <LusersCard networkSlug="net-full" />);
    const card = screen.getByTestId("lusers-card");
    expect(card.textContent).toContain("1,234");
    expect(card.textContent).toContain("56 invisible");
    expect(card.textContent).toContain("7");
    expect(card.textContent).toContain("89");
    expect(card.textContent).toContain("100 clients");
    expect(card.textContent).toContain("max 200");
    expect(card.textContent).toContain("max 5,000");
  });

  it("hides unknown row when count is 0 (Bahamut omits in some emit paths)", () => {
    setLusersBundle("net-no-unknown", { ...FULL_SNAPSHOT, unknown_connections: 0 });
    render(() => <LusersCard networkSlug="net-no-unknown" />);
    const card = screen.getByTestId("lusers-card");
    expect(card.textContent).not.toContain("unknown");
  });

  it("renders partial snapshot — null fields skip their respective rows", () => {
    setLusersBundle("net-partial", {
      total_users: 42,
      invisible: null,
      servers: null,
      operators: null,
      unknown_connections: null,
      channels_formed: null,
      local_clients: null,
      local_servers: null,
      current_local: null,
      max_local: null,
      current_global: null,
      max_global: null,
    });
    render(() => <LusersCard networkSlug="net-partial" />);
    const card = screen.getByTestId("lusers-card");
    expect(card.textContent).toContain("42");
    // operators row hidden when count is null
    expect(card.textContent).not.toContain("operators");
  });

  it("does not render for a different network", () => {
    setLusersBundle("net-x", FULL_SNAPSHOT);
    const { container } = render(() => <LusersCard networkSlug="net-other" />);
    expect(container.querySelector("[data-testid='lusers-card']")).toBeNull();
  });

  // P-0f — close button affordance, mirror of WhoisCard / WhowasCard.
  describe("close button (P-0f)", () => {
    it("renders a close button in the card header", () => {
      setLusersBundle("net-close-1", FULL_SNAPSHOT);
      render(() => <LusersCard networkSlug="net-close-1" />);
      expect(screen.getByLabelText("Dismiss LUSERS")).toBeInTheDocument();
    });

    it("dismissLusersCard removes the bundle so the card unmounts", () => {
      setLusersBundle("net-close-2", FULL_SNAPSHOT);
      const { container } = render(() => <LusersCard networkSlug="net-close-2" />);
      expect(container.querySelector("[data-testid='lusers-card']")).not.toBeNull();

      dismissLusersCard("net-close-2");

      expect(container.querySelector("[data-testid='lusers-card']")).toBeNull();
    });

    it("clicking the close button dismisses the card for THIS network only", () => {
      setLusersBundle("net-close-3a", FULL_SNAPSHOT);
      setLusersBundle("net-close-3b", FULL_SNAPSHOT);
      const { container: containerA } = render(() => <LusersCard networkSlug="net-close-3a" />);
      const { container: containerB } = render(() => <LusersCard networkSlug="net-close-3b" />);

      // Click the close button inside containerA scoped element so we
      // pick a deterministic instance even though both render the same
      // aria-label.
      const closeA = containerA.querySelector(
        "[aria-label='Dismiss LUSERS']",
      ) as HTMLButtonElement;
      fireEvent.click(closeA);

      // 3a dismissed; 3b survives because it's a separate network.
      expect(containerA.querySelector("[data-testid='lusers-card']")).toBeNull();
      expect(containerB.querySelector("[data-testid='lusers-card']")).not.toBeNull();
    });
  });
});
