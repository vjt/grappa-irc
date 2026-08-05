import { render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #888 — the far-behind unread badge.
//
// A far-behind window (#693) has its read cursor deliberately frozen, so its
// count does not move while the operator reads. Drawn as the ordinary solid
// pill it is indistinguishable from a live counter, and two people read it as
// a broken one on IRC the day the issue was filed. These tests pin the
// legibility contract: the badge takes a distinct treatment and says what the
// number means, the treatment clears the moment the far-behind record does,
// and it never leaks onto a window that is merely unread.
//
// The component is rendered directly rather than through `Sidebar` /
// `BottomBar`: the whole point of extracting it was that the two surfaces
// render the SAME triad, and testing it through one of them would leave the
// other's behaviour asserted nowhere. Both variants are driven here.

const mockFarBehind = vi.hoisted(() => ({
  value: {} as Record<string, { missed: number; resumeFrom: number } | undefined>,
}));
const mockMessages = vi.hoisted(() => ({ value: {} as Record<string, number> }));
const mockEvents = vi.hoisted(() => ({ value: {} as Record<string, number> }));
const mockMentions = vi.hoisted(() => ({ value: {} as Record<string, number> }));

vi.mock("../lib/scrollback", () => ({
  farBehindByChannel: () => mockFarBehind.value,
}));
vi.mock("../lib/selection", () => ({
  messagesUnread: () => mockMessages.value,
  eventsUnread: () => mockEvents.value,
}));
vi.mock("../lib/mentions", () => ({
  mentionCounts: () => mockMentions.value,
}));

import { channelKey } from "../lib/channelKey";
import WindowBadges, { badgeLabel, FAR_BEHIND_CLASS } from "../WindowBadges";

const BEHIND = channelKey("freenode", "#italia");
const NORMAL = channelKey("freenode", "#bnc");

beforeEach(() => {
  mockFarBehind.value = {};
  mockMessages.value = { [BEHIND]: 1832, [NORMAL]: 3 };
  mockEvents.value = { [BEHIND]: 40, [NORMAL]: 2 };
  mockMentions.value = {};
});

describe("#888 far-behind badge treatment", () => {
  it("marks BOTH unread badges of a far-behind window", () => {
    mockFarBehind.value = { [BEHIND]: { missed: 1832, resumeFrom: 10 } };
    const { container } = render(() => <WindowBadges channelKey={BEHIND} variant="sidebar" />);

    const msg = container.querySelector(".sidebar-msg-unread");
    const events = container.querySelector(".sidebar-events-unread");
    // Both counts come from the frozen server seed while far behind (the
    // memo's far-behind branch skips local counting wholesale), so both are
    // equally stuck and both must say so.
    expect(msg?.classList.contains(FAR_BEHIND_CLASS)).toBe(true);
    expect(events?.classList.contains(FAR_BEHIND_CLASS)).toBe(true);
    // The number itself is untouched — this is a treatment, not a rewrite.
    expect(msg?.textContent).toBe("1832");
  });

  it("says what the number means, on hover and to a screen reader", () => {
    mockFarBehind.value = { [BEHIND]: { missed: 1832, resumeFrom: 10 } };
    render(() => <WindowBadges channelKey={BEHIND} variant="sidebar" />);

    // Production's own wording, called the way production calls it — a
    // hardcoded string here would pass while the badge said something else.
    const expected = badgeLabel(1832, "messages", true);
    const badge = screen.getByTitle(expected);
    expect(badge.getAttribute("aria-label")).toBe(expected);
    // The label must name the distance AND the way out, not just repeat "1832".
    expect(expected).toContain("behind");
    expect(expected).toContain("jump");
  });

  it("leaves a merely-unread window alone", () => {
    mockFarBehind.value = { [BEHIND]: { missed: 1832, resumeFrom: 10 } };
    const { container } = render(() => <WindowBadges channelKey={NORMAL} variant="sidebar" />);

    const msg = container.querySelector(".sidebar-msg-unread");
    expect(msg?.textContent).toBe("3");
    // The far-behind record belongs to a DIFFERENT key; nothing about it may
    // reach this one (the leak `ScrollbackPane.test.tsx`'s sibling far-behind
    // test guards for the pane, guarded here for the badge).
    expect(msg?.classList.contains(FAR_BEHIND_CLASS)).toBe(false);
    expect(msg?.getAttribute("title")).toBeNull();
    expect(msg?.getAttribute("aria-label")).toBe(badgeLabel(3, "messages", false));
  });

  it("clears the treatment as soon as the far-behind record clears", () => {
    mockFarBehind.value = { [BEHIND]: { missed: 1832, resumeFrom: 10 } };
    const { container, unmount } = render(() => (
      <WindowBadges channelKey={BEHIND} variant="sidebar" />
    ));
    expect(
      container.querySelector(".sidebar-msg-unread")?.classList.contains(FAR_BEHIND_CLASS),
    ).toBe(true);
    unmount();

    // `jumpToUnread` / `dismissFarBehind` delete the record; the badge is a
    // plain unread pill again.
    mockFarBehind.value = {};
    const after = render(() => <WindowBadges channelKey={BEHIND} variant="sidebar" />);
    const msg = after.container.querySelector(".sidebar-msg-unread");
    expect(msg?.classList.contains(FAR_BEHIND_CLASS)).toBe(false);
    expect(msg?.getAttribute("title")).toBeNull();
  });

  it("applies the same treatment on the mobile bottom-bar variant", () => {
    mockFarBehind.value = { [BEHIND]: { missed: 1832, resumeFrom: 10 } };
    const { container } = render(() => <WindowBadges channelKey={BEHIND} variant="bottom-bar" />);

    const msg = container.querySelector(".bottom-bar-msg-unread");
    const events = container.querySelector(".bottom-bar-events-unread");
    expect(msg?.classList.contains(FAR_BEHIND_CLASS)).toBe(true);
    expect(events?.classList.contains(FAR_BEHIND_CLASS)).toBe(true);
    // Same modifier token on both surfaces — the stylesheet qualifies it per
    // badge class, so a second token here would silently unstyle one of them.
    expect(msg?.getAttribute("title")).toBe(badgeLabel(1832, "messages", true));
  });

  it("does not touch the mention badge (server-authoritative, not cursor-frozen)", () => {
    mockFarBehind.value = { [BEHIND]: { missed: 1832, resumeFrom: 10 } };
    mockMentions.value = { [BEHIND]: 4 };
    const { container } = render(() => <WindowBadges channelKey={BEHIND} variant="sidebar" />);

    const mention = container.querySelector(".sidebar-mention");
    expect(mention?.textContent).toBe("@4");
    expect(mention?.classList.contains(FAR_BEHIND_CLASS)).toBe(false);
  });

  it("renders nothing for a window with no counts at all", () => {
    mockMessages.value = {};
    mockEvents.value = {};
    const { container } = render(() => <WindowBadges channelKey={NORMAL} variant="sidebar" />);
    expect(container.querySelector("span")).toBeNull();
  });
});
