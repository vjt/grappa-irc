import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalChannel, channelKey } from "../lib/channelKey";
import { acceptConfirm, confirmRequest, dismissConfirm } from "../lib/confirmDialog";

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

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    postJoin: (t: string, slug: string, name: string, key: string | null) =>
      postJoinMock(t, slug, name, key),
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
});

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
