import { render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
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

// #1077 — a REAL signal behind the mute list, not a plain holder. The
// acceptance is explicitly reactive ("unmuting restores full brightness
// without a reload"), and a getter over a mutable object satisfies a
// re-rendered assertion while a snapshot read would too. Only a signal that
// notifies mid-life can tell the two apart. `conversationMute` itself stays
// REAL — the badge must consult the same predicate the cycle-skip does, and
// stubbing it would assert the stub.
const [mutedTargets, setMutedTargets] = createSignal<
  Record<string, { until: number | null }> | undefined
>({});
vi.mock("../lib/notificationPrefs", () => ({
  notificationPrefs: () => ({ muted_targets: mutedTargets() }),
}));

import { channelKey } from "../lib/channelKey";
import { conversationMuteKey } from "../lib/conversationMute";
import WindowBadges, { badgeLabel, FAR_BEHIND_CLASS, MUTED_CLASS } from "../WindowBadges";

const BEHIND = channelKey("freenode", "#italia");
const NORMAL = channelKey("freenode", "#bnc");
const DM = channelKey("freenode", "Vjt");

beforeEach(() => {
  mockFarBehind.value = {};
  mockMessages.value = { [BEHIND]: 1832, [NORMAL]: 3, [DM]: 7 };
  mockEvents.value = { [BEHIND]: 40, [NORMAL]: 2 };
  mockMentions.value = {};
  setMutedTargets({});
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

// #1077 — a muted conversation's badges dim. #866 Q4 had answered "does the
// mute change the badge?" with no; this revises that to "yes, visually". The
// counts and the cycle are untouched — `orderUnreadWindows` is not involved
// here at all — so what these tests constrain is the modifier and nothing else.
describe("#1077 muted badge treatment", () => {
  it("dims all three badges of a muted channel", () => {
    mockMentions.value = { [BEHIND]: 4 };
    setMutedTargets({ [conversationMuteKey("#italia")]: { until: null } });
    const { container } = render(() => <WindowBadges channelKey={BEHIND} variant="sidebar" />);

    // All three, not just the two counters: #866 Q2 already ruled that a
    // mention inside a muted room is not a stop, so a full-strength `@4`
    // beside two dimmed counters would contradict a decision already made.
    for (const sel of [".sidebar-msg-unread", ".sidebar-events-unread", ".sidebar-mention"]) {
      expect(container.querySelector(sel)?.classList.contains(MUTED_CLASS)).toBe(true);
    }
    // A treatment, not a rewrite — the numbers are the same numbers.
    expect(container.querySelector(".sidebar-msg-unread")?.textContent).toBe("1832");
    expect(container.querySelector(".sidebar-mention")?.textContent).toBe("@4");
  });

  it("dims a muted DM, keyed on the peer nick and folded", () => {
    // The window is `Vjt`; the mute was stored for `vjt`. The badge must fold
    // to match, exactly as the notify path and the cycle-skip do — a raw
    // compare here would leave a mixed-case query window shouting.
    setMutedTargets({ [conversationMuteKey("vjt")]: { until: null } });
    const { container } = render(() => <WindowBadges channelKey={DM} variant="sidebar" />);
    expect(container.querySelector(".sidebar-msg-unread")?.classList.contains(MUTED_CLASS)).toBe(
      true,
    );
  });

  it("leaves an unmuted window at full strength", () => {
    setMutedTargets({ [conversationMuteKey("#italia")]: { until: null } });
    const { container } = render(() => <WindowBadges channelKey={NORMAL} variant="sidebar" />);
    // The mute belongs to a DIFFERENT conversation; nothing about it may reach
    // this one.
    expect(container.querySelector(".sidebar-msg-unread")?.classList.contains(MUTED_CLASS)).toBe(
      false,
    );
  });

  it("restores full brightness the moment the mute is lifted, with no re-render", () => {
    setMutedTargets({ [conversationMuteKey("#italia")]: { until: null } });
    const { container } = render(() => <WindowBadges channelKey={BEHIND} variant="sidebar" />);
    const msg = container.querySelector(".sidebar-msg-unread");
    expect(msg?.classList.contains(MUTED_CLASS)).toBe(true);

    // The SAME node, after the mute list changes underneath it. Re-rendering
    // here would pass even against a snapshot read, which is the whole defect
    // the acceptance names.
    setMutedTargets({});
    expect(msg?.classList.contains(MUTED_CLASS)).toBe(false);
  });

  it("composes with the far-behind treatment rather than replacing it", () => {
    mockFarBehind.value = { [BEHIND]: { missed: 1832, resumeFrom: 10 } };
    setMutedTargets({ [conversationMuteKey("#italia")]: { until: null } });
    const { container } = render(() => <WindowBadges channelKey={BEHIND} variant="sidebar" />);
    const msg = container.querySelector(".sidebar-msg-unread");
    expect(msg?.classList.contains(FAR_BEHIND_CLASS)).toBe(true);
    expect(msg?.classList.contains(MUTED_CLASS)).toBe(true);
  });

  it("applies the same modifier on the mobile bottom-bar variant", () => {
    mockMentions.value = { [BEHIND]: 4 };
    setMutedTargets({ [conversationMuteKey("#italia")]: { until: null } });
    const { container } = render(() => <WindowBadges channelKey={BEHIND} variant="bottom-bar" />);
    for (const sel of [
      ".bottom-bar-msg-unread",
      ".bottom-bar-events-unread",
      ".bottom-bar-mention",
    ]) {
      expect(container.querySelector(sel)?.classList.contains(MUTED_CLASS)).toBe(true);
    }
  });
});
