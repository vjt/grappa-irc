import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import InviteAckRows from "../InviteAckRows";
import { appendInviteAck } from "../lib/inviteAck";

// P-0e — invite-ack synthetic rows. Render assertions only — wire
// dispatch is covered by subscribe.test.ts.
//
// Test isolation: store accumulates per (slug, channel) with no
// production "clear" verb (the ephemeral lifecycle is page reload —
// matching the "lost on refetch" design rule). Each test uses a
// unique (slug, channel) tuple to avoid cross-test contamination.

describe("InviteAckRows", () => {
  it("renders no row when no entry exists for (slug, channel)", () => {
    const { container } = render(() => <InviteAckRows networkSlug="net-a" channelName="#empty" />);
    expect(container.querySelector("[data-testid='invite-ack-row']")).toBeNull();
  });

  it("renders one synthetic row per invite_ack with peer + arrow text", () => {
    appendInviteAck("net-b", "#italia", "alice");
    render(() => <InviteAckRows networkSlug="net-b" channelName="#italia" />);
    const row = screen.getByTestId("invite-ack-row");
    expect(row).toBeInTheDocument();
    expect(row.textContent).toContain("→");
    expect(row.textContent).toContain("invited");
    expect(row.textContent).toContain("alice");
  });

  it("matches case-insensitively on channel name", () => {
    appendInviteAck("net-c", "#Italia", "bob");
    render(() => <InviteAckRows networkSlug="net-c" channelName="#italia" />);
    expect(screen.getByTestId("invite-ack-row").textContent).toContain("bob");
  });

  it("renders multiple rows in arrival order (history-of-intent, NOT last-write-wins)", () => {
    appendInviteAck("net-d", "#italia", "alice");
    appendInviteAck("net-d", "#italia", "bob");
    appendInviteAck("net-d", "#italia", "carol");
    render(() => <InviteAckRows networkSlug="net-d" channelName="#italia" />);
    const rows = screen.getAllByTestId("invite-ack-row");
    expect(rows).toHaveLength(3);
    const [alice, bob, carol] = rows as [HTMLElement, HTMLElement, HTMLElement];
    expect(alice.textContent).toContain("alice");
    expect(bob.textContent).toContain("bob");
    expect(carol.textContent).toContain("carol");
  });

  it("does not render for a different channel on the same network", () => {
    appendInviteAck("net-e", "#italia", "alice");
    const { container } = render(() => <InviteAckRows networkSlug="net-e" channelName="#other" />);
    expect(container.querySelector("[data-testid='invite-ack-row']")).toBeNull();
  });

  it("does not render for a different network", () => {
    appendInviteAck("net-f", "#italia", "alice");
    const { container } = render(() => (
      <InviteAckRows networkSlug="net-other" channelName="#italia" />
    ));
    expect(container.querySelector("[data-testid='invite-ack-row']")).toBeNull();
  });
});
