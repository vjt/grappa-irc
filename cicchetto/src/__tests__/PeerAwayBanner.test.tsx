import { render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { dismissPeerAway, setPeerAway } from "../lib/peerAway";
import PeerAwayBanner from "../PeerAwayBanner";

// P-0b — peer-away banner. Render assertions only — store wiring +
// userTopic dispatch is covered by the userTopic narrow test.

describe("PeerAwayBanner", () => {
  afterEach(() => {
    dismissPeerAway("azzurra", "alice");
    dismissPeerAway("azzurra", "ALICE");
  });

  it("renders no DOM node when no entry exists for (slug, peer)", () => {
    const { container } = render(() => <PeerAwayBanner networkSlug="azzurra" peer="alice" />);
    expect(container.querySelector("[data-testid='peer-away-banner']")).toBeNull();
  });

  it("renders peer + message when entry exists", () => {
    setPeerAway("azzurra", "alice", "Gone fishing");
    render(() => <PeerAwayBanner networkSlug="azzurra" peer="alice" />);
    const banner = screen.getByTestId("peer-away-banner");
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toContain("alice");
    expect(banner.textContent).toContain("is away");
    expect(banner.textContent).toContain("Gone fishing");
  });

  it("matches case-insensitively on peer nick", () => {
    // Server emits the peer's nick in whatever case upstream sent it;
    // the store keys lowercased, the banner lookups lowercased.
    setPeerAway("azzurra", "Alice", "AFK");
    render(() => <PeerAwayBanner networkSlug="azzurra" peer="ALICE" />);
    const banner = screen.getByTestId("peer-away-banner");
    expect(banner.textContent).toContain("AFK");
  });

  it("dismiss button removes the banner", () => {
    setPeerAway("azzurra", "alice", "Gone fishing");
    render(() => <PeerAwayBanner networkSlug="azzurra" peer="alice" />);
    const close = screen.getByLabelText("Dismiss away notice");
    close.click();
    expect(screen.queryByTestId("peer-away-banner")).toBeNull();
  });

  it("a second peer_away for the same peer replaces the message (last-write-wins)", () => {
    setPeerAway("azzurra", "alice", "AFK");
    setPeerAway("azzurra", "alice", "Back in 5");
    render(() => <PeerAwayBanner networkSlug="azzurra" peer="alice" />);
    const banner = screen.getByTestId("peer-away-banner");
    expect(banner.textContent).toContain("Back in 5");
    expect(banner.textContent).not.toContain("AFK");
  });

  it("does not render for a different peer on the same network", () => {
    setPeerAway("azzurra", "alice", "Gone fishing");
    const { container } = render(() => <PeerAwayBanner networkSlug="azzurra" peer="bob" />);
    expect(container.querySelector("[data-testid='peer-away-banner']")).toBeNull();
  });

  it("does not render for a different network", () => {
    setPeerAway("azzurra", "alice", "Gone fishing");
    const { container } = render(() => <PeerAwayBanner networkSlug="other" peer="alice" />);
    expect(container.querySelector("[data-testid='peer-away-banner']")).toBeNull();
  });
});
