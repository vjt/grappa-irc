import { render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { dismissPeerAway, setPeerAway } from "../lib/peerAway";
import PeerAwayBanner from "../PeerAwayBanner";

// P-0b — peer-away banner. Render assertions only — store wiring +
// userTopic dispatch is covered by the userTopic narrow test.

const CHOSEN = ["bob", "constructor", "__proto__"];

describe("PeerAwayBanner", () => {
  afterEach(() => {
    dismissPeerAway("azzurra", "alice");
    dismissPeerAway("azzurra", "ALICE");
    dismissPeerAway("azzurra", "Foo[1]");
    for (const peer of CHOSEN) dismissPeerAway("azzurra", peer);
  });

  // issue 2453 — a nick is the peer's to choose, and `constructor` and
  // `__proto__` are valid ones; "bob" runs first as the control.
  it.each(CHOSEN)(
    "renders no banner for %s while another peer is away, then its own until dismissed",
    (peer) => {
      setPeerAway("azzurra", "alice", "Gone fishing");
      render(() => <PeerAwayBanner networkSlug="azzurra" peer={peer} />);
      expect(screen.queryByTestId("peer-away-banner")).toBeNull();

      setPeerAway("azzurra", peer, "brb");
      expect(screen.getByTestId("peer-away-banner").textContent).toContain("brb");

      screen.getByLabelText("Dismiss away notice").click();
      expect(screen.queryByTestId("peer-away-banner")).toBeNull();
    },
  );

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
    // the store keys via asciiFold, the banner lookups via the same
    // fold, so casing never matters.
    setPeerAway("azzurra", "Alice", "AFK");
    render(() => <PeerAwayBanner networkSlug="azzurra" peer="ALICE" />);
    const banner = screen.getByTestId("peer-away-banner");
    expect(banner.textContent).toContain("AFK");
  });

  // #525 — store key + banner lookup fold CASE only (CASEMAPPING=ascii),
  // so `Foo[1]` (set) and `foo[1]` (lookup) are one peer; a brace twin
  // `foo{1}` would be distinct.
  it("matches on the ASCII fold (case only) between store and lookup", () => {
    setPeerAway("azzurra", "Foo[1]", "brb");
    render(() => <PeerAwayBanner networkSlug="azzurra" peer="foo[1]" />);
    const banner = screen.getByTestId("peer-away-banner");
    expect(banner.textContent).toContain("brb");
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
