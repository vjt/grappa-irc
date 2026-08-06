import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirmJoinChannel, switchToChannelWindow } from "../lib/channelJoin";
import {
  dismissInviteToast,
  inviteToasts,
  parseInviteLinkPath,
  routeInviteTarget,
} from "../lib/inviteLink";

// #793 — shareable channel invite links: `irc.sindro.me/<network>/<channel>`.
//
// Two halves, both here: the PATH parser (the new reader — `pushTarget.ts`
// only ever read `location.search`) and the ROUTE (what the parsed target
// does). The route delegates to the #648 join verb rather than reimplementing
// confirm-then-join, so these assertions are about DELEGATION, not about the
// modal's internals (ConfirmModal has its own tests).

vi.mock("../lib/channelJoin", () => ({
  confirmJoinChannel: vi.fn(),
  switchToChannelWindow: vi.fn(),
}));

vi.mock("../lib/networks", () => ({
  networkBySlug: vi.fn((slug: string) =>
    slug === "azzurra" ? { id: 1, slug: "azzurra", kind: "user" } : undefined,
  ),
  channelsBySlug: vi.fn(() => ({ azzurra: [{ id: 10, name: "#bofh" }] })),
}));

describe("parseInviteLinkPath", () => {
  it("reads a bare two-segment path and implies the # sigil", () => {
    expect(parseInviteLinkPath("/azzurra/sniffo")).toEqual({
      networkSlug: "azzurra",
      channelName: "#sniffo",
      kind: "channel",
    });
  });

  it("keeps a percent-encoded # sigil instead of doubling it", () => {
    // `#` cannot travel literally in a path — a browser would read it as the
    // fragment and the server would never see the segment at all (#755: the
    // room segment was the one URL component never encoded).
    expect(parseInviteLinkPath("/azzurra/%23sniffo")?.channelName).toBe("#sniffo");
  });

  it("passes the non-# chantypes sigils through untouched", () => {
    expect(parseInviteLinkPath("/azzurra/&local")?.channelName).toBe("&local");
    expect(parseInviteLinkPath("/azzurra/+modeless")?.channelName).toBe("+modeless");
    expect(parseInviteLinkPath("/azzurra/!ABCDEsecret")?.channelName).toBe("!ABCDEsecret");
  });

  it("percent-decodes a non-ASCII channel name", () => {
    expect(parseInviteLinkPath("/azzurra/caff%C3%A8")?.channelName).toBe("#caffè");
  });

  it("preserves the raw casing (the display spelling goes on the wire)", () => {
    expect(parseInviteLinkPath("/azzurra/Sniffo")?.channelName).toBe("#Sniffo");
  });

  it("tolerates a trailing slash", () => {
    expect(parseInviteLinkPath("/azzurra/sniffo/")?.channelName).toBe("#sniffo");
  });

  it("rejects a path that is not exactly two segments", () => {
    expect(parseInviteLinkPath("/")).toBeNull();
    expect(parseInviteLinkPath("/azzurra")).toBeNull();
    expect(parseInviteLinkPath("/azzurra/sniffo/extra")).toBeNull();
  });

  it("rejects the reserved /share/:token client route", () => {
    // A real two-segment route already exists — without this, a visitor
    // share link would be read as an invite to network `share`.
    expect(parseInviteLinkPath("/share/abc123")).toBeNull();
  });

  it("rejects a channel segment carrying a comma", () => {
    // JOIN takes a comma-separated LIST: an unfiltered comma turns one
    // invite into a multi-channel join the sender never wrote.
    expect(parseInviteLinkPath("/azzurra/sniffo,bofh")).toBeNull();
    expect(parseInviteLinkPath("/azzurra/sniffo%2Cbofh")).toBeNull();
  });

  it("rejects a channel segment carrying whitespace or control bytes", () => {
    expect(parseInviteLinkPath("/azzurra/sniffo%20bofh")).toBeNull();
    expect(parseInviteLinkPath("/azzurra/sniffo%0D%0AQUIT")).toBeNull();
    expect(parseInviteLinkPath("/azzurra/sniffo%07")).toBeNull();
  });

  it("rejects a malformed percent-escape instead of throwing", () => {
    expect(parseInviteLinkPath("/azzurra/%ZZ")).toBeNull();
  });

  it("rejects a bare sigil with no name", () => {
    expect(parseInviteLinkPath("/azzurra/%23")).toBeNull();
  });
});

describe("routeInviteTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const t of inviteToasts()) dismissInviteToast(t.id);
  });

  it("delegates an unjoined channel to the #648 confirm-then-join verb", () => {
    routeInviteTarget({ networkSlug: "azzurra", channelName: "#sniffo", kind: "channel" });
    expect(confirmJoinChannel).toHaveBeenCalledWith("azzurra", "#sniffo");
    expect(switchToChannelWindow).not.toHaveBeenCalled();
  });

  it("switches with NO modal when the channel is already in the server's list", () => {
    routeInviteTarget({ networkSlug: "azzurra", channelName: "#bofh", kind: "channel" });
    expect(switchToChannelWindow).toHaveBeenCalledWith("azzurra", "#bofh");
    expect(confirmJoinChannel).not.toHaveBeenCalled();
  });

  it("folds the already-in comparison (a link is spelled by a human)", () => {
    routeInviteTarget({ networkSlug: "azzurra", channelName: "#BoFH", kind: "channel" });
    expect(switchToChannelWindow).toHaveBeenCalledWith("azzurra", "#BoFH");
    expect(confirmJoinChannel).not.toHaveBeenCalled();
  });

  it("says so, visibly, when the network is not bound for this recipient", () => {
    // Open decision 1 of #793 — cross-user network identity is unresolved, so
    // this branch deliberately does NOT join anything. What it must not do is
    // fail silently: the recipient clicked a link and is owed an answer.
    routeInviteTarget({ networkSlug: "libera", channelName: "#sniffo", kind: "channel" });
    expect(confirmJoinChannel).not.toHaveBeenCalled();
    expect(switchToChannelWindow).not.toHaveBeenCalled();
    const toasts = inviteToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.networkSlug).toBe("libera");
  });
});
