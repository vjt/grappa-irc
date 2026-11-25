import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ConnectionState, type Network } from "../lib/api";
import { dismissJoinToast, joinToasts, joinToastText } from "../lib/channelJoin";
import { canonicalChannel, channelKey } from "../lib/channelKey";
import { acceptConfirm, confirmRequest, dismissConfirm } from "../lib/confirmDialog";
import { friendlyApiError } from "../lib/friendlyApiError";
import { _setScheduleExpiryForTest } from "../lib/toasts";

// #648 — confirmJoinChannel is the verb behind a click-to-join `#channel`
// affordance in scrollback. It REUSES the same join primitive as compose.ts
// `/join` and DirectoryPane row taps — postJoin (the one REST/socket call) +
// setSelectedChannel (client-side focus) — and the server-owned
// window_states map for the already-joined test. No new socket call, no
// parallel join path.
//
// Boundaries mocked (api.postJoin, auth.token, selection.setSelectedChannel,
// windowState.windowStateByChannel); the REAL confirmDialog store drives the
// modal flow (requestConfirm → acceptConfirm), and the REAL channelKey /
// canonicalChannel fold — same "production key builder" posture as
// DirectoryPane.test.tsx.

const postJoinMock = vi.fn<
  (t: string, slug: string, name: string, key: string | null) => Promise<void>
>(() => Promise.resolve());
const { tokenMock } = vi.hoisted(() => ({
  tokenMock: vi.fn<() => string | null>(() => "tok"),
}));
const setSelectedChannelMock = vi.fn();
const windowStateByChannelMock = vi.fn<() => Record<string, string>>(() => ({}));
const deleteInviteMock = vi.fn<(t: string, slug: string, name: string) => Promise<void>>(() =>
  Promise.resolve(),
);
const patchNetworkMock = vi.fn<
  (t: string, slug: string, body: { connection_state: string }) => Promise<unknown>
>(() => Promise.resolve({}));
// issue 2719 — what the store says about the network. `undefined` is a slug
// the store does not hold.
const networkBySlugMock = vi.fn<(slug: string) => Network | undefined>(() => undefined);

// Every REST call in the order it went out, so a test can say "the PATCH, THEN
// the POST" rather than only "both happened".
const wire: string[] = [];

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    postJoin: (t: string, slug: string, name: string, key: string | null) => {
      wire.push(`POST ${slug} ${name}`);
      return postJoinMock(t, slug, name, key);
    },
    patchNetwork: (t: string, slug: string, body: { connection_state: string }) => {
      wire.push(`PATCH ${slug} ${body.connection_state}`);
      return patchNetworkMock(t, slug, body);
    },
    deleteInvite: (t: string, slug: string, name: string) => deleteInviteMock(t, slug, name),
  };
});

vi.mock("../lib/networks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/networks")>();
  return { ...actual, networkBySlug: (slug: string) => networkBySlugMock(slug) };
});

vi.mock("../lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth")>();
  return { ...actual, token: () => tokenMock() };
});

vi.mock("../lib/selection", () => ({
  setSelectedChannel: (...args: unknown[]) => setSelectedChannelMock(...args),
}));

vi.mock("../lib/windowState", () => ({
  windowStateByChannel: () => windowStateByChannelMock(),
}));

const SLUG = "azzurra";

const netIn = (connection_state: ConnectionState): Network =>
  ({
    kind: "user",
    id: 1,
    slug: SLUG,
    nick: "vjt",
    connection_state,
    connection_state_reason: null,
    connection_state_changed_at: null,
    inserted_at: "",
    updated_at: "",
  }) as unknown as Network;

beforeEach(() => {
  vi.clearAllMocks();
  wire.length = 0;
  networkBySlugMock.mockReturnValue(netIn("connected"));
  windowStateByChannelMock.mockReturnValue({});
  tokenMock.mockReturnValue("tok");
  dismissConfirm();
  _setScheduleExpiryForTest(() => {});
  for (const t of joinToasts()) dismissJoinToast(t.id);
});

// Drains the verb's awaits: the REST call(s), then the continuation.
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe("confirmJoinChannel — already joined (#648)", () => {
  it("switches straight to the window with NO confirm and NO join (asking to join an open window is noise)", async () => {
    windowStateByChannelMock.mockReturnValue({
      [channelKey(SLUG, "#Sniffo")]: "joined",
    });
    const { confirmJoinChannel } = await import("../lib/channelJoin");
    confirmJoinChannel(SLUG, "#Sniffo");

    expect(confirmRequest()).toBeNull();
    expect(postJoinMock).not.toHaveBeenCalled();
    // Focus lands on the FOLDED key (window_states + selection are keyed
    // folded, #510) — mixed-case would target a phantom window.
    expect(setSelectedChannelMock).toHaveBeenCalledWith({
      networkSlug: SLUG,
      channelName: canonicalChannel("#Sniffo"),
      kind: "channel",
    });
  });
});

describe("confirmJoinChannel — not joined (#648)", () => {
  it("opens a confirm naming the RAW channel, and does NOT join until confirmed", async () => {
    const { confirmJoinChannel } = await import("../lib/channelJoin");
    confirmJoinChannel(SLUG, "#Sniffo");

    const req = confirmRequest();
    expect(req).not.toBeNull();
    expect(req?.body).toContain("#Sniffo");
    // Nothing happens on the wire or focus until the user says yes.
    expect(postJoinMock).not.toHaveBeenCalled();
    expect(setSelectedChannelMock).not.toHaveBeenCalled();
  });

  it("on confirm: joins with the RAW channel then focuses the FOLDED key", async () => {
    const { confirmJoinChannel } = await import("../lib/channelJoin");
    confirmJoinChannel(SLUG, "#Sniffo");
    acceptConfirm();
    // performJoin awaits postJoin before focusing — let the microtask drain.
    await Promise.resolve();
    await Promise.resolve();

    // Wire/display spelling on the JOIN (the server does its own casemapping).
    expect(postJoinMock).toHaveBeenCalledWith("tok", SLUG, "#Sniffo", null);
    // Focus on the folded key, and only AFTER the join resolved (#244: a
    // failed join never foregrounds a phantom window).
    expect(setSelectedChannelMock).toHaveBeenCalledWith({
      networkSlug: SLUG,
      channelName: canonicalChannel("#Sniffo"),
      kind: "channel",
    });
  });

  it("on cancel: no join, no focus", async () => {
    const { confirmJoinChannel } = await import("../lib/channelJoin");
    confirmJoinChannel(SLUG, "#chan");
    dismissConfirm();
    await Promise.resolve();
    expect(postJoinMock).not.toHaveBeenCalled();
    expect(setSelectedChannelMock).not.toHaveBeenCalled();
  });

  it("no-ops the join when no token is set (post-logout race)", async () => {
    tokenMock.mockReturnValue(null);
    const { confirmJoinChannel } = await import("../lib/channelJoin");
    confirmJoinChannel(SLUG, "#chan");
    acceptConfirm();
    await Promise.resolve();
    expect(postJoinMock).not.toHaveBeenCalled();
  });
});

// issue 2719 — a join that fails is told to the person who asked for it.
// `performJoin` used to `console.warn` and nothing else, on the premise that
// its catch saw only "401 / network down"; a 404 from a network with no
// session reached it too, and the person who clicked saw nothing at all.
describe("a failed join raises a toast (issue 2719)", () => {
  it("names the channel, the network and the server's refusal, on the confirm door", async () => {
    const err = new ApiError(404, "not_found");
    postJoinMock.mockRejectedValueOnce(err);
    const { confirmJoinChannel } = await import("../lib/channelJoin");
    confirmJoinChannel(SLUG, "#Sniffo");
    acceptConfirm();
    await settle();

    expect(joinToasts()).toHaveLength(1);
    const [toast] = joinToasts();
    expect(toast && joinToastText(toast)).toBe(
      `Couldn't join #Sniffo on ${SLUG}: ${friendlyApiError(err)}`,
    );
    // #244 still holds: a failed join never foregrounds a phantom window.
    expect(setSelectedChannelMock).not.toHaveBeenCalled();
  });

  it("raises it on the invite door too, which opens no confirm", async () => {
    postJoinMock.mockRejectedValueOnce(new ApiError(503, "upstream_unavailable"));
    const { acceptInvite } = await import("../lib/channelJoin");
    acceptInvite(SLUG, "#chan");
    await settle();

    expect(confirmRequest()).toBeNull();
    expect(joinToasts()).toHaveLength(1);
    expect(setSelectedChannelMock).not.toHaveBeenCalled();
  });

  it("carries a transport failure's own message, not an ApiError's copy", async () => {
    postJoinMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { acceptInvite } = await import("../lib/channelJoin");
    acceptInvite(SLUG, "#chan");
    await settle();

    const [toast] = joinToasts();
    expect(toast && joinToastText(toast)).toBe(`Couldn't join #chan on ${SLUG}: Failed to fetch`);
  });

  it("raises nothing on a join that succeeds", async () => {
    const { acceptInvite } = await import("../lib/channelJoin");
    acceptInvite(SLUG, "#chan");
    await settle();

    expect(joinToasts()).toHaveLength(0);
  });
});

// issue 2719 — THE join verb, behind every door that joins a channel. A JOIN
// sent to a network with no session answers 404 and opens nothing, so the
// verb reconnects first whenever the store says there is no session
// (`hasNoLiveSession`: parked, failed). The PATCH spawns the session before it
// answers, and the server holds the JOIN until 001, so the two calls are
// awaited back to back with no wait between them.
describe("joinChannel (issue 2719)", () => {
  it("joins a connected network with the POST alone, then focuses the FOLDED key", async () => {
    const { joinChannel } = await import("../lib/channelJoin");
    await joinChannel("tok", SLUG, ["#Sniffo"], null);

    expect(wire).toEqual([`POST ${SLUG} #Sniffo`]);
    expect(setSelectedChannelMock).toHaveBeenCalledWith({
      networkSlug: SLUG,
      channelName: canonicalChannel("#Sniffo"),
      kind: "channel",
    });
  });

  it.each(["parked", "failed"] as const)(
    "reconnects a %s network, THEN joins, then focuses",
    async (state) => {
      networkBySlugMock.mockReturnValue(netIn(state));
      const { joinChannel } = await import("../lib/channelJoin");
      await joinChannel("tok", SLUG, ["#sniffo"], null);

      expect(wire).toEqual([`PATCH ${SLUG} connected`, `POST ${SLUG} #sniffo`]);
      expect(patchNetworkMock).toHaveBeenCalledWith("tok", SLUG, {
        connection_state: "connected",
      });
      expect(setSelectedChannelMock).toHaveBeenCalledTimes(1);
    },
  );

  // #1675 — its session is alive and retrying; the server holds the JOIN
  // until 001 (issue 2114). A PATCH would be a wasted request that resets the
  // backoff counter, not a bounce (`Networks.connect/1` is a no-op there).
  it("does not reconnect a failing network", async () => {
    networkBySlugMock.mockReturnValue(netIn("failing"));
    const { joinChannel } = await import("../lib/channelJoin");
    await joinChannel("tok", SLUG, ["#sniffo"], null);

    expect(wire).toEqual([`POST ${SLUG} #sniffo`]);
  });

  it("leaves a slug the store does not hold to the server's answer", async () => {
    networkBySlugMock.mockReturnValue(undefined);
    const { joinChannel } = await import("../lib/channelJoin");
    await joinChannel("tok", SLUG, ["#sniffo"], null);

    expect(wire).toEqual([`POST ${SLUG} #sniffo`]);
  });

  it("sends a /join list as ONE comma-list with its key, and focuses the first", async () => {
    const { joinChannel } = await import("../lib/channelJoin");
    await joinChannel("tok", SLUG, ["#A", "#b"], "sekrit");

    expect(postJoinMock).toHaveBeenCalledWith("tok", SLUG, "#A,#b", "sekrit");
    expect(setSelectedChannelMock).toHaveBeenCalledWith({
      networkSlug: SLUG,
      channelName: canonicalChannel("#A"),
      kind: "channel",
    });
  });

  it("throws a refused reconnect to its caller, and sends no POST", async () => {
    networkBySlugMock.mockReturnValue(netIn("parked"));
    const refusal = new ApiError(503, "network_circuit_open");
    patchNetworkMock.mockRejectedValueOnce(refusal);
    const { joinChannel } = await import("../lib/channelJoin");

    await expect(joinChannel("tok", SLUG, ["#sniffo"], null)).rejects.toBe(refusal);
    expect(wire).toEqual([`PATCH ${SLUG} connected`]);
    expect(setSelectedChannelMock).not.toHaveBeenCalled();
  });

  it("throws a refused join to its caller, and focuses nothing", async () => {
    const refusal = new ApiError(404, "not_found");
    postJoinMock.mockRejectedValueOnce(refusal);
    const { joinChannel } = await import("../lib/channelJoin");

    await expect(joinChannel("tok", SLUG, ["#sniffo"], null)).rejects.toBe(refusal);
    expect(setSelectedChannelMock).not.toHaveBeenCalled();
  });

  // identityMoved.ts: a continuation that outlived its identity sends not one
  // request more. The POST would carry a retired bearer.
  it("sends no POST when the identity moved during the reconnect", async () => {
    networkBySlugMock.mockReturnValue(netIn("parked"));
    patchNetworkMock.mockImplementationOnce(() => {
      tokenMock.mockReturnValue("other");
      return Promise.resolve({});
    });
    const { joinChannel } = await import("../lib/channelJoin");
    await joinChannel("tok", SLUG, ["#sniffo"], null);

    expect(wire).toEqual([`PATCH ${SLUG} connected`]);
    expect(setSelectedChannelMock).not.toHaveBeenCalled();
  });

  it("focuses nothing when the identity moved during the join", async () => {
    postJoinMock.mockImplementationOnce(() => {
      tokenMock.mockReturnValue(null);
      return Promise.resolve();
    });
    const { joinChannel } = await import("../lib/channelJoin");
    await joinChannel("tok", SLUG, ["#sniffo"], null);

    expect(setSelectedChannelMock).not.toHaveBeenCalled();
  });
});

// issue 2719 — consent FIRST on the confirm door (the orch's ruling Q1, option
// A): a park is the person's own act, so it is never undone without a yes, and
// the one question names both the reconnect and the join.
describe("confirmJoinChannel on a network with no session (issue 2719)", () => {
  it("asks ONE question naming the reconnect, and sends nothing before the yes", async () => {
    networkBySlugMock.mockReturnValue(netIn("parked"));
    const { confirmJoinChannel } = await import("../lib/channelJoin");
    confirmJoinChannel(SLUG, "#Sniffo");

    expect(confirmRequest()?.body).toBe(`${SLUG} is disconnected. Reconnect it and join #Sniffo?`);
    expect(confirmRequest()?.confirmLabel).toBe("Reconnect and join");
    expect(wire).toEqual([]);
  });

  it("on cancel: no PATCH, no POST — the park stands", async () => {
    networkBySlugMock.mockReturnValue(netIn("failed"));
    const { confirmJoinChannel } = await import("../lib/channelJoin");
    confirmJoinChannel(SLUG, "#sniffo");
    dismissConfirm();
    await settle();

    expect(wire).toEqual([]);
  });

  it("on yes: reconnects, joins, focuses", async () => {
    networkBySlugMock.mockReturnValue(netIn("parked"));
    const { confirmJoinChannel } = await import("../lib/channelJoin");
    confirmJoinChannel(SLUG, "#sniffo");
    acceptConfirm();
    await settle();

    expect(wire).toEqual([`PATCH ${SLUG} connected`, `POST ${SLUG} #sniffo`]);
    expect(setSelectedChannelMock).toHaveBeenCalledTimes(1);
  });

  it("a refused reconnect raises the join toast and sends no POST", async () => {
    networkBySlugMock.mockReturnValue(netIn("parked"));
    const refusal = new ApiError(503, "network_circuit_open");
    patchNetworkMock.mockRejectedValueOnce(refusal);
    const { confirmJoinChannel } = await import("../lib/channelJoin");
    confirmJoinChannel(SLUG, "#sniffo");
    acceptConfirm();
    await settle();

    expect(wire).toEqual([`PATCH ${SLUG} connected`]);
    const [toast] = joinToasts();
    expect(toast && joinToastText(toast)).toBe(
      `Couldn't join #sniffo on ${SLUG}: ${friendlyApiError(refusal)}`,
    );
  });

  it("asks the plain #648 question on a connected network", async () => {
    const { confirmJoinChannel } = await import("../lib/channelJoin");
    confirmJoinChannel(SLUG, "#Sniffo");

    expect(confirmRequest()?.body).toBe("Join #Sniffo?");
    expect(confirmRequest()?.confirmLabel).toBe("Join");
  });
});

// #976 — the REFUSAL, the other answer to the question `acceptInvite` answers.
// It DELETEs the invite resource; the server drops the `:invited` window and
// broadcasts the drop, so there is deliberately no local state write here —
// cic never originates window state.
describe("declineInvite (#976)", () => {
  it("DELETEs the invite with the RAW channel spelling (the server folds the key)", async () => {
    const { declineInvite } = await import("../lib/channelJoin");
    declineInvite(SLUG, "#Sniffo");
    await Promise.resolve();

    expect(deleteInviteMock).toHaveBeenCalledWith("tok", SLUG, "#Sniffo");
  });

  it("does NOT join, focus, or confirm — a refusal is not a leave and not an accept", async () => {
    const { declineInvite } = await import("../lib/channelJoin");
    declineInvite(SLUG, "#Sniffo");
    await Promise.resolve();

    expect(postJoinMock).not.toHaveBeenCalled();
    expect(setSelectedChannelMock).not.toHaveBeenCalled();
    expect(confirmRequest()).toBeNull();
  });

  it("no-ops when no token is set (post-logout race)", async () => {
    tokenMock.mockReturnValue(null);
    const { declineInvite } = await import("../lib/channelJoin");
    declineInvite(SLUG, "#chan");
    await Promise.resolve();

    expect(deleteInviteMock).not.toHaveBeenCalled();
  });

  it("swallows a rejected DELETE instead of surfacing an unhandled rejection", async () => {
    // A `not_invited` here means the window already left `:invited` (joined,
    // or declined on another device) — the banner is about to disappear from
    // that state change anyway. Fire-and-forget, same posture as performJoin.
    deleteInviteMock.mockRejectedValueOnce(new Error("not_invited"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { declineInvite } = await import("../lib/channelJoin");

    expect(() => declineInvite(SLUG, "#chan")).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
