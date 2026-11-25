import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
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

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    postJoin: (t: string, slug: string, name: string, key: string | null) =>
      postJoinMock(t, slug, name, key),
    deleteInvite: (t: string, slug: string, name: string) => deleteInviteMock(t, slug, name),
  };
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

beforeEach(() => {
  vi.clearAllMocks();
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
