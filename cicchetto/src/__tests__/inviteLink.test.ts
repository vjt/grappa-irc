import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { confirmJoinChannel, switchToChannelWindow } from "../lib/channelJoin";
import { friendlyApiError } from "../lib/friendlyApiError";
import {
  dismissInviteToast,
  inviteToasts,
  inviteToastText,
  parseInviteLinkUrl,
  routeInviteTarget,
} from "../lib/inviteLink";
import { attachNetwork } from "../lib/networkAttach";
import { refetchNetworks } from "../lib/networks";

// #793 — shareable channel invite links: `irc.sindro.me/?go=azzurra/sniffo`.
//
// Two halves, both here: the QUERY parser and the ROUTE (what the parsed
// target does). The route delegates to the #648 join verb rather than
// reimplementing confirm-then-join, so these assertions are about DELEGATION,
// not about the modal's internals (ConfirmModal has its own tests).
//
// Half of the parse block is about what the BROWSER does to the value before
// this code ever sees it. `?go=` puts the channel inside a query param, where
// `#`, `&` and `+` each have a meaning of their own — those cases are pinned
// against measured behaviour (node's WHATWG URL), not against what the
// characters "should" do.

vi.mock("../lib/channelJoin", () => ({
  confirmJoinChannel: vi.fn(),
  switchToChannelWindow: vi.fn(),
}));

// issue 2703 — the bound set and the bearer are SIGNALS, not constants: an
// invite for an available network attaches it and then waits for it to appear
// among the bound ones, and only a reactive mock can make that happen
// mid-test. (Precedent: serverPeek.test.ts builds its mocks the same way.)
const live = vi.hoisted(() => ({
  setBound: (_slugs: readonly string[]): void => {},
  setToken: (_t: string | null): void => {},
  available: [] as string[],
  // What the SERVER holds. `refetchNetworks` copies it into the bound set,
  // so a test can let the re-read bring a network in, rather than simulate a
  // broadcast this tab may never see.
  serverBound: ["azzurra"] as readonly string[],
}));

const h = vi.hoisted(() => ({ addNetwork: vi.fn<(t: string, slug: string) => Promise<void>>() }));

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  addNetwork: (t: string, slug: string) => h.addNetwork(t, slug),
}));

vi.mock("../lib/networks", async () => {
  const { createSignal } = await import("solid-js");
  const [bound, setBound] = createSignal<readonly string[]>(["azzurra"]);
  live.setBound = (slugs) => void setBound(slugs);
  return {
    // #1861 — casemappingForSlug (lib/casemapping.ts) resolves the fold
    // through this map, so the mock has to carry it.
    networkIdBySlug: () => undefined,
    networkBySlug: (slug: string) =>
      bound().includes(slug) ? { id: 1, slug, kind: "user" } : undefined,
    channelsBySlug: vi.fn(() => ({ azzurra: [{ id: 10, name: "#bofh" }] })),
    refetchUser: vi.fn(),
    refetchNetworks: vi.fn(() => setBound(live.serverBound)),
  };
});

vi.mock("../lib/auth", async () => {
  const { createSignal } = await import("solid-js");
  const [token, setToken] = createSignal<string | null>("tok");
  live.setToken = (t) => void setToken(t);
  return { token };
});

// What `/me` offers this recipient to attach: the server's own answer to "may
// I bind this network?", for both subject kinds (issue 2703).
vi.mock("../lib/home", () => ({
  homeData: () => ({
    networks: [],
    available_networks: live.available.map((slug) => ({ slug })),
  }),
}));

vi.mock("../lib/networkAttach", () => ({ attachNetwork: vi.fn() }));

// The real verb, for the test that is about what the verb re-reads. Its own
// imports still resolve to the mocks above.
const { attachNetwork: realAttachNetwork } =
  await vi.importActual<typeof import("../lib/networkAttach")>("../lib/networkAttach");

describe("parseInviteLinkUrl", () => {
  it("reads ?go=<network>/<channel> and implies the # sigil", () => {
    expect(parseInviteLinkUrl("/?go=azzurra/sniffo")).toEqual({
      networkSlug: "azzurra",
      channelName: "#sniffo",
      kind: "channel",
    });
  });

  it("reads an absolute URL the same as a relative one", () => {
    // `location.href` is what the boot reader passes, and it is absolute.
    expect(parseInviteLinkUrl("https://irc.sindro.me/?go=azzurra/sniffo")?.channelName).toBe(
      "#sniffo",
    );
  });

  it("ignores the path — a two-segment path is no longer an invite", () => {
    // The retired form. `?go=` exists precisely so an invite cannot collide
    // with a client route, so the path must carry no meaning at all here.
    expect(parseInviteLinkUrl("/azzurra/sniffo")).toBeNull();
    expect(parseInviteLinkUrl("/share/abc123")).toBeNull();
  });

  it("takes a percent-encoded # sigil instead of doubling it", () => {
    expect(parseInviteLinkUrl("/?go=azzurra/%23sniffo")?.channelName).toBe("#sniffo");
  });

  it("gets nothing from a LITERAL # — the browser eats it as the fragment", () => {
    // Measured: `new URL("/?go=azzurra/#sniffo")` has search `?go=azzurra/`
    // and hash `#sniffo`. The channel never reaches the app, so the value is
    // one segment and the whole invite is refused rather than half-read.
    // This is #755's lesson in a query param: the room segment is the one URL
    // component people forget to encode.
    expect(parseInviteLinkUrl("/?go=azzurra/#sniffo")).toBeNull();
  });

  it("gets nothing from a LITERAL & — the browser reads it as the next param", () => {
    // Same shape as the `#` case, different delimiter: `&local` starts a
    // second query param and `go` truncates to `azzurra/`.
    expect(parseInviteLinkUrl("/?go=azzurra/&local")).toBeNull();
  });

  it("reads a literal + as a SPACE, and a space is refused", () => {
    // `application/x-www-form-urlencoded` decoding turns `+` into a space —
    // the one delimiter that does NOT truncate the value but silently
    // rewrites it. A space cannot appear in a channel name, so the forbidden
    // -byte scan catches it. Encoded (`%2B`), the sigil arrives intact.
    expect(parseInviteLinkUrl("/?go=azzurra/+modeless")).toBeNull();
    expect(parseInviteLinkUrl("/?go=azzurra/%2Bmodeless")?.channelName).toBe("+modeless");
  });

  it("takes the non-# chantypes sigils when they are encoded", () => {
    expect(parseInviteLinkUrl("/?go=azzurra/%26local")?.channelName).toBe("&local");
    expect(parseInviteLinkUrl("/?go=azzurra/!ABCDEsecret")?.channelName).toBe("!ABCDEsecret");
  });

  it("reads a wholly-encoded value, separator slash included", () => {
    // `encodeURIComponent("azzurra/#sniffo")` escapes the separator too. The
    // decode restores it, so the over-careful writer gets the same target as
    // the minimal one.
    expect(parseInviteLinkUrl(`/?go=${encodeURIComponent("azzurra/#sniffo")}`)).toEqual({
      networkSlug: "azzurra",
      channelName: "#sniffo",
      kind: "channel",
    });
  });

  it("percent-decodes a non-ASCII channel name", () => {
    expect(parseInviteLinkUrl("/?go=azzurra/caff%C3%A8")?.channelName).toBe("#caffè");
  });

  it("preserves the raw casing (the display spelling goes on the wire)", () => {
    expect(parseInviteLinkUrl("/?go=azzurra/Sniffo")?.channelName).toBe("#Sniffo");
  });

  it("tolerates a trailing slash", () => {
    expect(parseInviteLinkUrl("/?go=azzurra/sniffo/")?.channelName).toBe("#sniffo");
  });

  it("rejects a value that is not exactly two segments", () => {
    expect(parseInviteLinkUrl("/?go=azzurra")).toBeNull();
    expect(parseInviteLinkUrl("/?go=azzurra/sniffo/extra")).toBeNull();
  });

  it("returns null when there is no go param at all", () => {
    expect(parseInviteLinkUrl("/")).toBeNull();
    expect(parseInviteLinkUrl("/?network=azzurra&channel=%23sniffo")).toBeNull();
    expect(parseInviteLinkUrl("/?go=")).toBeNull();
  });

  it("returns null on an unparseable URL instead of throwing", () => {
    expect(parseInviteLinkUrl("http://[")).toBeNull();
  });

  it("rejects a channel segment carrying a comma", () => {
    // JOIN takes a comma-separated LIST: an unfiltered comma turns one
    // invite into a multi-channel join the sender never wrote.
    expect(parseInviteLinkUrl("/?go=azzurra/sniffo,bofh")).toBeNull();
    expect(parseInviteLinkUrl("/?go=azzurra/sniffo%2Cbofh")).toBeNull();
  });

  it("rejects a channel segment carrying whitespace or control bytes", () => {
    expect(parseInviteLinkUrl("/?go=azzurra/sniffo%20bofh")).toBeNull();
    expect(parseInviteLinkUrl("/?go=azzurra/sniffo%0D%0AQUIT")).toBeNull();
    expect(parseInviteLinkUrl("/?go=azzurra/sniffo%07")).toBeNull();
  });

  it("keeps a malformed percent-escape verbatim rather than throwing", () => {
    // Measured, and a DELIBERATE change from the path reader, which decoded
    // by hand and got a URIError for `%ZZ`. `URLSearchParams` follows WHATWG
    // and leaves an undecodable sequence as its own bytes, so a typo names a
    // legal-if-silly channel instead of being refused. Safe because the
    // consent modal prints the channel it is about to join: the human reads
    // `#%ZZ` and says no.
    expect(parseInviteLinkUrl("/?go=azzurra/%ZZ")?.channelName).toBe("#%ZZ");
  });

  // Issue 2424 — a lone `#` or `&` is an ordinary channel upstream, and the
  // server's `Identifier.valid_channel?/1` now says so. An invite to one used
  // to be thrown away here as "a bare sigil names nothing".
  it("takes a lone # or & as the channel it names (issue 2424)", () => {
    expect(parseInviteLinkUrl("/?go=azzurra/%23")).toEqual({
      networkSlug: "azzurra",
      channelName: "#",
      kind: "channel",
    });
    expect(parseInviteLinkUrl("/?go=azzurra/%26")?.channelName).toBe("&");
  });

  it("rejects a lone + or !, which names no channel", () => {
    expect(parseInviteLinkUrl("/?go=azzurra/%2B")).toBeNull();
    expect(parseInviteLinkUrl("/?go=azzurra/!")).toBeNull();
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

  it("says so, visibly, when this server offers the recipient no such network", () => {
    // Not bound AND not in `/me`'s available tier: the slug names a network
    // this server does not have, or one this recipient may not bind. The two
    // read the same on purpose (issue 2703, Q4): a different answer for each
    // would tell a stranger which networks a deployment carries.
    routeInviteTarget({ networkSlug: "libera", channelName: "#sniffo", kind: "channel" });
    expect(attachNetwork).not.toHaveBeenCalled();
    expect(confirmJoinChannel).not.toHaveBeenCalled();
    expect(switchToChannelWindow).not.toHaveBeenCalled();
    const toasts = inviteToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ networkSlug: "libera", reason: "unavailable" });
  });
});

// issue 2703 — an invite for a network the recipient has not bound, but may:
// attach it with no modal of its own (vjt's ruling), then ask the #648 join
// question exactly as for a bound network.
describe("routeInviteTarget, available network", () => {
  const disagio = { networkSlug: "azzurra2", channelName: "#disagio", kind: "channel" } as const;

  beforeEach(() => {
    vi.clearAllMocks();
    for (const t of inviteToasts()) dismissInviteToast(t.id);
    vi.mocked(attachNetwork).mockReset();
    h.addNetwork.mockReset();
    live.setBound(["azzurra"]);
    live.setToken("tok");
    live.available = ["azzurra2"];
    live.serverBound = ["azzurra"];
  });

  it("attaches it with no modal, and asks to join only once it is bound", async () => {
    vi.mocked(attachNetwork).mockResolvedValue(undefined);
    routeInviteTarget(disagio);
    expect(attachNetwork).toHaveBeenCalledWith("tok", "azzurra2");

    // The attach answered, but the network is not in the list yet: no modal
    // for a network the sidebar does not show.
    await vi.waitFor(() => expect(attachNetwork).toHaveReturned());
    await Promise.resolve();
    expect(confirmJoinChannel).not.toHaveBeenCalled();

    live.setBound(["azzurra", "azzurra2"]);
    await vi.waitFor(() => expect(confirmJoinChannel).toHaveBeenCalledWith("azzurra2", "#disagio"));
    expect(confirmJoinChannel).toHaveBeenCalledTimes(1);
    expect(inviteToasts()).toHaveLength(0);
  });

  it("goes on to the join when the attach answers 409 already_attached", async () => {
    // Another tab of the same account won the race: the network IS attached
    // on the server. The verb re-reads on a 409 as on a 204, so the network
    // reaches this tab through the read it asked for. The winning tab's
    // `network_attached` broadcast is not replayed to a topic joined after it,
    // so nothing here simulates one: the real verb runs, and only its re-read
    // can bring the network in.
    live.serverBound = ["azzurra", "azzurra2"];
    h.addNetwork.mockRejectedValue(new ApiError(409, "already_attached"));
    vi.mocked(attachNetwork).mockImplementation(realAttachNetwork);
    routeInviteTarget(disagio);

    await vi.waitFor(() => expect(confirmJoinChannel).toHaveBeenCalledWith("azzurra2", "#disagio"));
    expect(h.addNetwork).toHaveBeenCalledWith("tok", "azzurra2");
    expect(refetchNetworks).toHaveBeenCalled();
    expect(inviteToasts()).toHaveLength(0);
  });

  it("tells a recipient whose bearer is gone that it is not signed in, and attaches nothing", async () => {
    // The post-logout race: the invite routes after the token went away.
    live.setToken(null);
    routeInviteTarget(disagio);

    await vi.waitFor(() => expect(inviteToasts()).toHaveLength(1));
    expect(inviteToasts()[0]).toMatchObject({
      networkSlug: "azzurra2",
      reason: "attach_failed",
      message: "not signed in",
    });
    expect(attachNetwork).not.toHaveBeenCalled();
    expect(confirmJoinChannel).not.toHaveBeenCalled();
  });

  it("raises the server's refusal as the invite toast and joins nothing", async () => {
    const refusal = new ApiError(403, "network_not_visitor_enabled");
    vi.mocked(attachNetwork).mockRejectedValue(refusal);
    routeInviteTarget(disagio);

    await vi.waitFor(() => expect(inviteToasts()).toHaveLength(1));
    expect(inviteToasts()[0]).toMatchObject({
      networkSlug: "azzurra2",
      reason: "attach_failed",
      message: friendlyApiError(refusal),
    });
    live.setBound(["azzurra", "azzurra2"]);
    await Promise.resolve();
    expect(confirmJoinChannel).not.toHaveBeenCalled();
  });

  it("joins nothing for an identity that left while the network was coming up", async () => {
    vi.mocked(attachNetwork).mockResolvedValue(undefined);
    routeInviteTarget(disagio);
    await vi.waitFor(() => expect(attachNetwork).toHaveReturned());

    // Logged out and back in as somebody else who happens to hold the same
    // network: the consent question belongs to the account that clicked.
    live.setToken("someone-else");
    live.setBound(["azzurra", "azzurra2"]);
    await Promise.resolve();
    expect(confirmJoinChannel).not.toHaveBeenCalled();
    expect(inviteToasts()).toHaveLength(0);
  });
});

describe("inviteToastText", () => {
  it("says the network is not available here, whichever of the two it is", () => {
    // ONE sentence for "this server has no such network" and "you may not
    // bind it" (issue 2703, Q4): no enumeration oracle.
    expect(inviteToastText({ networkSlug: "ircnet", reason: "unavailable" })).toBe(
      "Invite for ircnet — that network is not available here.",
    );
  });

  it("carries the server's refusal when the attach was turned down", () => {
    const message = friendlyApiError(new ApiError(503, "network_busy"));
    expect(inviteToastText({ networkSlug: "ircnet", reason: "attach_failed", message })).toBe(
      `Invite for ircnet — ${message}`,
    );
  });
});
