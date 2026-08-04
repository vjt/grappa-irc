// #788 — an async scrollback verb that outlives its identity must do NOTHING
// further: no request on the wire, no write into the store.
//
// Every async verb in `scrollback.ts` captures `token()` at entry and then
// awaits. The nine `onIdentityChange` resets clear STATE; they cancel nothing
// in flight. So a rotation or a detach landing inside one of those awaits
// leaves the continuation holding a bearer the server has already revoked —
// and it sends it. Reproduced in a browser on the real bundle (see the issue):
// a `/messages/count` went out 10ms AFTER its own bearer was revoked.
//
// The harm is not just the 401. It is the #281 harm class: a request for the
// OLD identity's channel 404s when the new identity is not attached to that
// network, and the host's `http-404` fail2ban jail bans the client IP at the
// firewall — a routine account switch self-bans the user.
//
// The sibling harm the same continuation causes without touching the wire: the
// page it already fetched lands in a store the rotation just purged, so the
// new identity renders the old one's scrollback.
//
// The mock of `../auth` here is a REAL Solid signal, not the flat
// `token: () => value` stub the sibling suites use. That stub is not reactive,
// so `identityScopedStore`'s `createEffect(on(token))` never fires and no
// purge ever happens — the rotation these cases turn on would not exist.

import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrollbackMessage } from "../api";

// Mirrors loadInitialScrollback.test.ts: keep importing scrollback's
// transitive graph from opening a real WebSocket against jsdom's
// about:blank base URL.
vi.mock("../socket", () => ({
  joinUser: vi.fn(() => ({ on: vi.fn(), push: vi.fn().mockReturnValue({ receive: vi.fn() }) })),
  joinChannel: vi.fn(() => ({
    join: vi.fn(() => ({ receive: vi.fn().mockReturnValue({ receive: vi.fn() }) })),
    on: vi.fn(),
  })),
  pushCloseQueryWindow: vi.fn(),
  pushOpenQueryWindow: vi.fn(),
  notifyClientClosing: vi.fn(),
  pushAwaySet: vi.fn(),
  pushAwayUnset: vi.fn(),
}));

const [mockToken, setMockToken] = createSignal<string | null>(null);
vi.mock("../auth", () => ({
  token: () => mockToken(),
  setToken: (v: string | null) => setMockToken(v),
}));

const listMessagesSpy = vi.fn<(...a: unknown[]) => Promise<ScrollbackMessage[]>>();
const listMessagesAfterSpy = vi.fn<(...a: unknown[]) => Promise<ScrollbackMessage[]>>();
const countMessagesAfterSpy = vi.fn<(...a: unknown[]) => Promise<number>>();
vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    listMessages: (...args: unknown[]) => listMessagesSpy(...args),
    listMessagesAfter: (...args: unknown[]) => listMessagesAfterSpy(...args),
    countMessagesAfter: (...args: unknown[]) => countMessagesAfterSpy(...args),
  };
});

const setReadCursorSpy = vi.fn().mockResolvedValue(undefined);
vi.mock("../readCursor", async () => {
  const actual = await vi.importActual<typeof import("../readCursor")>("../readCursor");
  return {
    ...actual,
    setReadCursor: (...args: Parameters<typeof actual.setReadCursor>) => setReadCursorSpy(...args),
  };
});

const row = (id: number): ScrollbackMessage => ({
  id,
  network: "net",
  channel: "#bofh",
  server_time: 1_700_000_000 + id,
  kind: "privmsg",
  sender: "peer",
  body: `line ${id}`,
  meta: {},
});

// A full `PAGE_LIMIT` page — the shape that makes `refreshScrollback` probe
// for the remainder, which is the measured #788 site.
const fullPage = (): ScrollbackMessage[] => Array.from({ length: 200 }, (_, i) => row(i + 1));

// Hold a REST call open so the rotation can land strictly inside its await,
// which is the whole point: the continuation resumes under a bearer the
// server has already revoked.
const gate = <T>(): { promise: Promise<T>; release: (value: T) => void } => {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

// Rotate and let Solid's effect queue run the identity resets before the
// held call is released.
const rotateTo = async (next: string | null): Promise<void> => {
  setMockToken(next);
  await Promise.resolve();
};

const bearersSeenBy = (spy: { mock: { calls: unknown[][] } }): unknown[] =>
  spy.mock.calls.map((c) => c[0]);

describe("#788 identity rotation mid-flight", () => {
  beforeEach(() => {
    listMessagesSpy.mockReset();
    listMessagesSpy.mockResolvedValue([]);
    listMessagesAfterSpy.mockReset();
    listMessagesAfterSpy.mockResolvedValue([]);
    countMessagesAfterSpy.mockReset();
    countMessagesAfterSpy.mockResolvedValue(0);
    setReadCursorSpy.mockClear();
    // Each test starts from a clean identity. Setting the token IS a
    // rotation, so this also fires the store purge between cases.
    setMockToken("tok-a");
  });

  it("does not probe with a bearer revoked while the backfill page was in flight", async () => {
    const { refreshScrollback } = await import("../scrollback");
    const page = gate<ScrollbackMessage[]>();
    listMessagesAfterSpy.mockReturnValue(page.promise);

    const pending = refreshScrollback("net", "#probe-stale");
    await rotateTo("tok-b");
    page.release(fullPage());
    await pending;

    expect(bearersSeenBy(countMessagesAfterSpy)).not.toContain("tok-a");
  });

  it("does not land a page fetched by the old identity in the purged store", async () => {
    const { refreshScrollback, scrollbackByChannel } = await import("../scrollback");
    const { channelKey } = await import("../channelKey");
    const page = gate<ScrollbackMessage[]>();
    listMessagesAfterSpy.mockReturnValue(page.promise);

    const pending = refreshScrollback("net", "#store-stale");
    await rotateTo("tok-b");
    page.release([row(1), row(2)]);
    await pending;

    expect(scrollbackByChannel()[channelKey("net", "#store-stale")]).toBeUndefined();
  });

  it("releases the per-key refresh lock on rotation so the new identity can backfill", async () => {
    const { refreshScrollback } = await import("../scrollback");
    const stale = gate<ScrollbackMessage[]>();
    listMessagesAfterSpy.mockReturnValueOnce(stale.promise);

    const pendingA = refreshScrollback("net", "#lock");
    await rotateTo("tok-b");
    const pendingB = refreshScrollback("net", "#lock");
    stale.release([]);
    await Promise.all([pendingA, pendingB]);

    expect(bearersSeenBy(listMessagesAfterSpy)).toContain("tok-b");
  });

  it("does not baseline the cold-open read cursor with a revoked bearer", async () => {
    const { loadInitialScrollback } = await import("../scrollback");
    const page = gate<ScrollbackMessage[]>();
    listMessagesSpy.mockReturnValue(page.promise);

    const pending = loadInitialScrollback("net", "#cursor-stale");
    await rotateTo("tok-b");
    page.release([row(203), row(202), row(201)]);
    await pending;

    expect(bearersSeenBy(setReadCursorSpy)).not.toContain("tok-a");
  });
});
