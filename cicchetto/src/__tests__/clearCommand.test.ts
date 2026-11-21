import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";
import type { CommandContext } from "../lib/commands/context";
import { clearCommand } from "../lib/commands/window";
import { acceptConfirm, confirmRequest, dismissConfirm } from "../lib/confirmDialog";
import { encryptedWindowName, HOME_WINDOW_NAME, SERVER_WINDOW_NAME } from "../lib/windowKinds";

// issue 2428 — `/clear`. The handler's whole job is to answer three questions
// before anything destructive can happen: is this a window that HAS server
// scrollback, how many rows would go, and did the operator mean it.
//
// Only `lib/api` is stubbed (partial mock, `importOriginal`): the confirm is
// the REAL store, so "the modal opened with this body" is asserted on the
// object the modal itself would render, and "the operator confirmed" is the
// real `acceptConfirm` — the same call the button makes.
vi.mock(import("../lib/api"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getArchiveTargetCount: vi.fn(),
    deleteArchiveEntry: vi.fn(),
  };
});

const SLUG = "clear-net";

const context = (key: string, submittedFrom: string): CommandContext => ({
  key: channelKey(SLUG, key),
  networkSlug: SLUG,
  submittedFrom,
  text: "/clear",
  token: "tok",
  getActiveChannel: () => null,
  sigils: () => ["#", "&"],
  requireChannel: (verb: string) => ({ error: `${verb}: not a channel` }),
  requireNetworkId: () => 1,
  resolveBareWhoisNick: () => ({ error: "no nick" }),
  sendAction: async () => undefined,
});

const channelCtx = () => context("#chan", "#chan");
const queryCtx = () => context("Guest", "Guest");
const serverCtx = () => context(SERVER_WINDOW_NAME, SERVER_WINDOW_NAME);

describe("clearCommand (issue 2428)", () => {
  beforeEach(() => {
    dismissConfirm();
    vi.clearAllMocks();
  });

  it("opens a confirm naming the row count the server reports", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.getArchiveTargetCount).mockResolvedValue(1_234);

    const result = await clearCommand({ kind: "clear" }, channelCtx());

    expect(result).toEqual({ ok: true });
    const req = confirmRequest();
    expect(req).not.toBeNull();
    expect(req?.title).toBe("Clear window");
    // The number the operator reads is the server's, not a local count of
    // what this tab happens to have loaded.
    expect(req?.body).toContain("1234 messages");
    expect(req?.body).toContain("#chan");
    // A channel is not parted by clearing its history, and the copy says so.
    expect(req?.body).toContain("The channel stays joined.");
    // #195 — the destructive default is Cancel.
    expect(req?.defaultButton).toBe("cancel");
  });

  it("deletes only when the operator confirms", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.getArchiveTargetCount).mockResolvedValue(3);
    vi.mocked(api.deleteArchiveEntry).mockResolvedValue(undefined);

    await clearCommand({ kind: "clear" }, channelCtx());

    // Opening the dialog alone must not touch the server.
    expect(api.deleteArchiveEntry).not.toHaveBeenCalled();

    acceptConfirm();
    expect(api.deleteArchiveEntry).toHaveBeenCalledWith("tok", SLUG, "#chan");
  });

  it("says the window stays open for a query, and the server window keeps filling", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.getArchiveTargetCount).mockResolvedValue(2);

    await clearCommand({ kind: "clear" }, queryCtx());
    expect(confirmRequest()?.body).toContain("The window stays open.");

    dismissConfirm();
    await clearCommand({ kind: "clear" }, serverCtx());
    const body = confirmRequest()?.body ?? "";
    expect(body).toContain("2 messages");
    expect(body).toContain("New server output keeps arriving");
  });

  // The use case that filed the issue: an oper's network tab. It has no
  // sigil, so the server classifies it as a query; the handler must still
  // send the literal `$server` as the target.
  it("targets $server literally", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.getArchiveTargetCount).mockResolvedValue(1);
    vi.mocked(api.deleteArchiveEntry).mockResolvedValue(undefined);

    await clearCommand({ kind: "clear" }, serverCtx());
    expect(api.getArchiveTargetCount).toHaveBeenCalledWith("tok", SLUG, SERVER_WINDOW_NAME);

    acceptConfirm();
    expect(api.deleteArchiveEntry).toHaveBeenCalledWith("tok", SLUG, SERVER_WINDOW_NAME);
  });

  it("opens no confirm when the window has nothing to clear", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.getArchiveTargetCount).mockResolvedValue(0);

    const result = await clearCommand({ kind: "clear" }, channelCtx());

    expect(result).toEqual({ error: "/clear: #chan has no scrollback" });
    expect(confirmRequest()).toBeNull();
  });

  // An encrypted window's history is the device's own and never in
  // `messages`, so the DELETE would be a no-op reporting success. Refused by
  // name, and — the load-bearing half — WITHOUT asking the server.
  it("refuses an encrypted window without a server round trip", async () => {
    const api = await import("../lib/api");
    const peer = "Guest";
    const result = await clearCommand(
      { kind: "clear" },
      // `submittedFrom` is the peer's nick for an encrypted query; the KEY is
      // what says which window this is.
      context(encryptedWindowName(peer), peer),
    );

    expect(result).toMatchObject({ error: expect.stringContaining("encrypted") });
    expect(api.getArchiveTargetCount).not.toHaveBeenCalled();
    expect(confirmRequest()).toBeNull();
  });

  it("refuses a virtual window", async () => {
    const api = await import("../lib/api");
    const result = await clearCommand(
      { kind: "clear" },
      context(HOME_WINDOW_NAME, HOME_WINDOW_NAME),
    );

    expect(result).toEqual({ error: `/clear: ${HOME_WINDOW_NAME} has no scrollback to clear` });
    expect(api.getArchiveTargetCount).not.toHaveBeenCalled();
  });

  // The count is the one thing that can fail before the dialog: a refused
  // fetch must read as an inline error, never as "0 rows" (which would look
  // like an empty window) and never as a dialog that cannot name its number.
  it("surfaces a failed count inline instead of opening the dialog", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.getArchiveTargetCount).mockRejectedValue(new Error("boom"));

    const result = await clearCommand({ kind: "clear" }, channelCtx());

    expect(result).toMatchObject({ error: expect.stringContaining("/clear:") });
    expect(confirmRequest()).toBeNull();
  });
});
