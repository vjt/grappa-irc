import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import InviteAckRows from "../InviteAckRows";
import { appendInviteAck } from "../lib/inviteAck";

// P-0e + P-0f — invite-ack synthetic rows. Render assertions only —
// wire dispatch is covered by userTopic.test.ts.
//
// Test isolation: store accumulates per (slug, channel) with no
// production "clear" verb (the ephemeral lifecycle is page reload —
// matching the "lost on refetch" design rule). Each test uses a
// unique network slug to avoid cross-test contamination.
//
// P-0f: component prop is `networkSlug` only (no longer per-channel).
// Mounted on the $server window; aggregates rows from ALL target
// channels invited to on that network.

describe("InviteAckRows", () => {
  it("renders no row when no entry exists for the network", () => {
    const { container } = render(() => <InviteAckRows networkSlug="net-a-empty" />);
    expect(container.querySelector("[data-testid='invite-ack-row']")).toBeNull();
  });

  it("renders one synthetic row per invite_ack with peer + arrow + target channel", () => {
    appendInviteAck("net-b", "#italia", "alice");
    render(() => <InviteAckRows networkSlug="net-b" />);
    const row = screen.getByTestId("invite-ack-row");
    expect(row).toBeInTheDocument();
    expect(row.textContent).toContain("→");
    expect(row.textContent).toContain("invited");
    expect(row.textContent).toContain("alice");
    expect(row.textContent).toContain("#italia");
  });

  it("aggregates rows across multiple target channels on the same network in arrival order", () => {
    appendInviteAck("net-c", "#italia", "alice");
    appendInviteAck("net-c", "#bofh", "bob");
    appendInviteAck("net-c", "#italia", "carol");
    render(() => <InviteAckRows networkSlug="net-c" />);
    const rows = screen.getAllByTestId("invite-ack-row");
    expect(rows).toHaveLength(3);
    const [alice, bob, carol] = rows as [HTMLElement, HTMLElement, HTMLElement];
    expect(alice.textContent).toContain("alice");
    expect(alice.textContent).toContain("#italia");
    expect(bob.textContent).toContain("bob");
    expect(bob.textContent).toContain("#bofh");
    expect(carol.textContent).toContain("carol");
    expect(carol.textContent).toContain("#italia");
  });

  it("renders multiple rows in arrival order (history-of-intent, NOT last-write-wins)", () => {
    appendInviteAck("net-d", "#italia", "alice");
    appendInviteAck("net-d", "#italia", "bob");
    appendInviteAck("net-d", "#italia", "carol");
    render(() => <InviteAckRows networkSlug="net-d" />);
    const rows = screen.getAllByTestId("invite-ack-row");
    expect(rows).toHaveLength(3);
    const [alice, bob, carol] = rows as [HTMLElement, HTMLElement, HTMLElement];
    expect(alice.textContent).toContain("alice");
    expect(bob.textContent).toContain("bob");
    expect(carol.textContent).toContain("carol");
  });

  it("does not render for a different network", () => {
    appendInviteAck("net-f", "#italia", "alice");
    const { container } = render(() => <InviteAckRows networkSlug="net-other" />);
    expect(container.querySelector("[data-testid='invite-ack-row']")).toBeNull();
  });
});
