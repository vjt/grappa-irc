// #160 — `setReadCursor` MUST NOT POST for virtual/synthetic pseudo-windows.
//
// The Home / directory / admin tabs are pseudo-windows whose channelName is
// a sentinel literal ($home / $admin / $list) or empty (mentions). None has
// a server-side channel row: a `POST /networks/:slug/channels/:chan/
// read-cursor` for them 404s ($home/$admin resolve to an unknown network
// slug) or 400s ($list is not a valid target name). In production nginx
// feeds those 4xx to fail2ban's http-4xx jail → repeated hits escalate the
// idling user into the `recidive` pf block, cutting them off web AND IRC
// (grappa-irc#160 — already hard-banned a legit beta user).
//
// The leak site is ScrollbackPane.onCleanup reading reactive props already
// advanced to the virtual selection; the fix guards at setReadCursor — the
// module that owns the POST — so every one of the settle / blur / leave /
// unmount callers inherits it, mirroring the existing messageId>0 contract.
//
// $server is EXCLUDED from the guard: it is a real scrollback-backed target
// (NumericRouter rows) the server accepts, and cic legitimately writes a
// cursor for it. This file pins both sides of that fence.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_WINDOW_NAME,
  HOME_WINDOW_NAME,
  LIST_WINDOW_NAME,
  SERVER_WINDOW_NAME,
} from "../windowKinds";

// Mock auth so importing readCursor (module-level on(token) arm) doesn't
// cascade into socket connect. setReadCursor takes `bearer` explicitly, so
// the token value here is irrelevant to the guard — it's the import that
// matters. Mirrors setCursorIfAdvances.test.ts / loadInitialScrollback.test.ts.
let mockTokenValue: string | null = null;
vi.mock("../auth", () => ({
  token: () => mockTokenValue,
  setToken: vi.fn((v: string | null) => {
    mockTokenValue = v;
  }),
}));

const fetchSpy = vi.fn<(...args: unknown[]) => Promise<{ ok: boolean; status: number }>>();

describe("setReadCursor — virtual-window guard (#160)", () => {
  beforeEach(async () => {
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);
    const { clearReadCursors } = await import("../readCursor");
    clearReadCursors();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The four non-backed windows: $home / $admin / $list + mentions (empty).
  for (const name of [HOME_WINDOW_NAME, ADMIN_WINDOW_NAME, LIST_WINDOW_NAME, ""]) {
    it(`does NOT POST for virtual window ${JSON.stringify(name)}`, async () => {
      const { setReadCursor } = await import("../readCursor");
      await setReadCursor("test-bearer", "net", name, 42);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  it("does NOT optimistically advance the local cursor for a virtual window", async () => {
    const { setReadCursor, getReadCursor } = await import("../readCursor");
    await setReadCursor("test-bearer", "net", HOME_WINDOW_NAME, 42);
    // A virtual window has no cursor to advance — the local signal map must
    // stay empty for it too, not just skip the POST.
    expect(getReadCursor("net", HOME_WINDOW_NAME)).toBeNull();
  });

  it("DOES POST for a real channel", async () => {
    const { setReadCursor } = await import("../readCursor");
    await setReadCursor("test-bearer", "net", "#chan", 42);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = fetchSpy.mock.calls[0]?.[0];
    expect(url).toContain("/channels/%23chan/read-cursor");
  });

  it("DOES POST for the $server pseudo-window (real scrollback-backed target)", async () => {
    const { setReadCursor } = await import("../readCursor");
    await setReadCursor("test-bearer", "net", SERVER_WINDOW_NAME, 42);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = fetchSpy.mock.calls[0]?.[0];
    expect(url).toContain(`/channels/${encodeURIComponent(SERVER_WINDOW_NAME)}/read-cursor`);
  });
});
