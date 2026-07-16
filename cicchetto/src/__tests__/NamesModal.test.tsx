import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import type { NamesReply } from "../lib/api";
import type { MemberEntry } from "../lib/memberTypes";
import { dismissNamesModal, setNamesReply } from "../lib/namesModal";
import {
  __resetForTest,
  overlayEscapeDepth,
  runTopmostOverlayEscape,
} from "../lib/overlayScrollLock";
import { setSelectedChannel } from "../lib/selection";
import NamesModal from "../NamesModal";

// #140 — NamesModal renders the buffered /names roster grouped by tier
// (Operators / Halfops / Voices / Users), hides empty sections, shows a
// per-section count, a "#channel — N people" heading, and dismisses on
// the close button / Esc. The nick-click → open-query interaction is
// covered end-to-end in e2e (it reuses MembersPane's tested verb pair).

const SLUG = "azzurra";

const roster = (members: MemberEntry[]): NamesReply => ({
  network: SLUG,
  channel: "#bofh",
  members,
});

const focusNetwork = (): void =>
  setSelectedChannel({ networkSlug: SLUG, channelName: "#bofh", kind: "channel" });

describe("NamesModal (#140)", () => {
  afterEach(() => {
    dismissNamesModal(SLUG);
    setSelectedChannel(null);
    __resetForTest();
  });

  it("renders the channel + people-count heading and the End-of-NAMES footer", () => {
    focusNetwork();
    setNamesReply(
      SLUG,
      roster([
        { nick: "alice", modes: ["@"] },
        { nick: "bob", modes: ["+"] },
        { nick: "carol", modes: [] },
      ]),
    );
    render(() => <NamesModal />);
    const modal = screen.getByTestId("names-modal");
    expect(modal.textContent).toContain("#bofh — 3 people");
    expect(modal.textContent).toContain("End of /NAMES list: 3");
  });

  it("groups members into tiered sections with per-section counts", () => {
    focusNetwork();
    setNamesReply(
      SLUG,
      roster([
        { nick: "op1", modes: ["@"] },
        { nick: "op2", modes: ["@"] },
        { nick: "hop", modes: ["%"] },
        { nick: "v1", modes: ["+"] },
        { nick: "plain1", modes: [] },
      ]),
    );
    render(() => <NamesModal />);
    expect(screen.getByText("Operators (2)")).toBeInTheDocument();
    expect(screen.getByText("Halfops (1)")).toBeInTheDocument();
    expect(screen.getByText("Voices (1)")).toBeInTheDocument();
    expect(screen.getByText("Users (1)")).toBeInTheDocument();
  });

  it("hides empty sections — an all-ops channel shows only Operators", () => {
    focusNetwork();
    setNamesReply(
      SLUG,
      roster([
        { nick: "alice", modes: ["@"] },
        { nick: "bob", modes: ["@"] },
      ]),
    );
    render(() => <NamesModal />);
    expect(screen.getByText("Operators (2)")).toBeInTheDocument();
    expect(screen.queryByText(/^Halfops/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Voices/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Users/)).not.toBeInTheDocument();
  });

  it("buckets a member by its highest tier (an op who is also voiced shows under Operators)", () => {
    focusNetwork();
    setNamesReply(SLUG, roster([{ nick: "boss", modes: ["@", "+"] }]));
    render(() => <NamesModal />);
    expect(screen.getByText("Operators (1)")).toBeInTheDocument();
    expect(screen.queryByText(/^Voices/)).not.toBeInTheDocument();
  });

  it("renders one person (singular) for a single-member roster", () => {
    focusNetwork();
    setNamesReply(SLUG, roster([{ nick: "solo", modes: [] }]));
    render(() => <NamesModal />);
    expect(screen.getByTestId("names-modal").textContent).toContain("#bofh — 1 person");
  });

  it("renders nothing when no roster is present for the active network", () => {
    focusNetwork();
    render(() => <NamesModal />);
    expect(screen.queryByTestId("names-modal")).not.toBeInTheDocument();
  });

  it("dismisses on the close button", () => {
    focusNetwork();
    setNamesReply(SLUG, roster([{ nick: "alice", modes: ["@"] }]));
    render(() => <NamesModal />);
    fireEvent.click(screen.getByLabelText("close names"));
    expect(screen.queryByTestId("names-modal")).not.toBeInTheDocument();
  });

  // #232 — Esc now closes via the shared overlay stack (createOverlayLock
  // onEscape → keybindings → runTopmostOverlayEscape), not a per-dialog
  // onKeyDown. runTopmostOverlayEscape is the exact verb the global keydown
  // listener invokes, so this proves the modal registered its close AND that
  // the close is focus-independent (no dialog focus required).
  it("closes on Escape via the shared overlay stack (focus-independent)", async () => {
    focusNetwork();
    setNamesReply(SLUG, roster([{ nick: "alice", modes: ["@"] }]));
    render(() => <NamesModal />);
    await waitFor(() => expect(overlayEscapeDepth()).toBe(1));
    expect(runTopmostOverlayEscape()).toBe(true);
    await waitFor(() => expect(screen.queryByTestId("names-modal")).not.toBeInTheDocument());
  });
});
