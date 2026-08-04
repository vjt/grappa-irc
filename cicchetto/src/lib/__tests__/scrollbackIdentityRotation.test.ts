// #788 — an async scrollback verb that outlives its identity must do NOTHING
// further: no request on the wire, no write into the store.
//
// Every async verb in `scrollback.ts` captures `token()` at entry and then
// awaits. The `onIdentityChange` resets clear STATE; they cancel nothing
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

// A full page — the shape that makes `refreshScrollback` probe for the
// remainder, which is the measured #788 site. The size is read back from the
// limit the module ASKED for rather than hardcoded to today's `PAGE_LIMIT`:
// a hardcoded 200 that drifts out of step would stop entering the probe
// branch at all, and the case would pass because it tested nothing. The
// "identity holds" control below fails loudly if that ever happens anyway.
const fullPageFor = (spy: { mock: { calls: unknown[][] } }): ScrollbackMessage[] => {
  const limit = spy.mock.calls[0]?.[4];
  if (typeof limit !== "number") throw new Error("no page limit observed on the wire");
  return Array.from({ length: limit }, (_, i) => row(i + 1));
};

// Hold a REST call open so the rotation can land strictly inside its await,
// which is the whole point: the continuation resumes under a bearer the
// server has already revoked.
const gate = <T>(): {
  promise: Promise<T>;
  release: (value: T) => void;
  fail: (err: Error) => void;
} => {
  let release!: (value: T) => void;
  let fail!: (err: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
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
    page.release(fullPageFor(listMessagesAfterSpy));
    await pending;

    expect(bearersSeenBy(countMessagesAfterSpy)).not.toContain("tok-a");
  });

  // The control for the case above: same harness, same full page, no rotation.
  // Without it, a full page that stopped being full would silently turn the
  // stale-probe case into an assertion about a branch nobody entered.
  it("does probe for the remainder when the identity holds", async () => {
    const { refreshScrollback } = await import("../scrollback");
    const page = gate<ScrollbackMessage[]>();
    listMessagesAfterSpy.mockReturnValue(page.promise);

    const pending = refreshScrollback("net", "#probe-live");
    page.release(fullPageFor(listMessagesAfterSpy));
    await pending;

    expect(bearersSeenBy(countMessagesAfterSpy)).toContain("tok-a");
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

  // The other half of the lock question. Clearing the Set on rotation is only
  // safe if the old continuation then keeps its hands off it: its `finally`
  // would otherwise delete a key the NEW identity re-added, unlocking a fetch
  // that is still running — and stamp that key as backfilled while it is not.
  it("does not release or stamp the new identity's in-flight refresh", async () => {
    const { refreshScrollback } = await import("../scrollback");
    const { channelKey } = await import("../channelKey");
    const stale = gate<ScrollbackMessage[]>();
    const live = gate<ScrollbackMessage[]>();
    listMessagesAfterSpy.mockReturnValueOnce(stale.promise);
    listMessagesAfterSpy.mockReturnValueOnce(live.promise);

    const pendingA = refreshScrollback("net", "#held");
    await rotateTo("tok-b");
    const pendingB = refreshScrollback("net", "#held");
    // A's continuation resumes and unwinds while B is still on the wire.
    stale.release([]);
    await pendingA;

    // B still holds the key, so a re-entrant call is still a no-op...
    await refreshScrollback("net", "#held");
    expect(bearersSeenBy(listMessagesAfterSpy).filter((b) => b === "tok-b")).toHaveLength(1);
    // ...and nothing has told a spec that B's backfill landed.
    const stamped = (window as Window & { __cic_scrollbackRefreshed?: Set<string> })
      .__cic_scrollbackRefreshed;
    expect(stamped?.has(channelKey("net", "#held"))).not.toBe(true);

    live.release([]);
    await pendingB;
  });

  // The reject path, which is the LIKELIER arrival: a bearer revoked while the
  // request was in flight comes back as `api.ts`'s 401 throw, not as a clean
  // resolve. `loadInitialScrollback`'s catch releases the load-once gate — the
  // new identity's gate, past a rotation.
  it("does not release the new identity's load-once gate when the old fetch 401s", async () => {
    const { loadInitialScrollback, wasLoaded } = await import("../scrollback");
    const stale = gate<ScrollbackMessage[]>();
    listMessagesSpy.mockReturnValueOnce(stale.promise);

    const pendingA = loadInitialScrollback("net", "#gate");
    await rotateTo("tok-b");
    const pendingB = loadInitialScrollback("net", "#gate");
    stale.fail(new Error("401 Unauthorized"));
    await Promise.all([pendingA, pendingB]);

    expect(wasLoaded("net", "#gate")).toBe(true);
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
