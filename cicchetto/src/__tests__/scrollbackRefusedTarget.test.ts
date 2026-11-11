// #2409 — a 400 from the scrollback REST surface is a VERDICT about the
// target, not a transient failure, and must not be retried.
//
// Measured in the issue: a window whose name the server refused produced 20
// `GET /networks/<n>/channels/<c>/messages` requests over 33 minutes, each
// answered 400, and the edge's `http-400` fail2ban jail banned the operator's
// whole IP. The client's retries came from the ordinary verbs — a re-selection
// re-running `loadInitialScrollback`, every join-ok and every reconnect
// re-running `refreshScrollback` — each of which treated the refusal as a
// flake worth trying again.
//
// The latch is per key and only on 400: 401 belongs to `identityMoved`, 404
// can be a network that is not bound yet, 429 is a rate limit that clears. The
// control case below pins that boundary — a 500 must still be retried, or the
// latch would have quietly turned every transient failure into a dead window.

import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GapProbe, ScrollbackMessage } from "../lib/api";
import { ApiError } from "../lib/apiError";

// Mirrors scrollbackIdentityRotation.test.ts: keep scrollback's transitive
// graph from opening a real WebSocket against jsdom's about:blank base URL.
vi.mock("../lib/socket", () => ({
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

// A REAL Solid signal, as in the rotation suite: `identityScopedStore` clears
// the latch on an identity transition through `createEffect(on(token))`, and a
// flat stub would leave the reset unexercised.
const [mockToken, setMockToken] = createSignal<string | null>(null);
vi.mock("../lib/auth", () => ({
  token: () => mockToken(),
  setToken: (v: string | null) => setMockToken(v),
}));

const listMessagesSpy = vi.fn<(...a: unknown[]) => Promise<ScrollbackMessage[]>>();
const listMessagesAfterSpy = vi.fn<(...a: unknown[]) => Promise<ScrollbackMessage[]>>();
const countMessagesAfterSpy = vi.fn<(...a: unknown[]) => Promise<GapProbe>>();
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    listMessages: (...args: unknown[]) => listMessagesSpy(...args),
    listMessagesAfter: (...args: unknown[]) => listMessagesAfterSpy(...args),
    countMessagesAfter: (...args: unknown[]) => countMessagesAfterSpy(...args),
  };
});

const setReadCursorSpy = vi.fn().mockResolvedValue(undefined);
vi.mock("../lib/readCursor", async () => {
  const actual = await vi.importActual<typeof import("../lib/readCursor")>("../lib/readCursor");
  return {
    ...actual,
    setReadCursor: (...args: Parameters<typeof actual.setReadCursor>) => setReadCursorSpy(...args),
  };
});

// A fresh identity per case: the latch is identity-scoped, so reusing one
// token across cases would let an earlier case's refusal silence a later one.
let identity = 0;
const freshIdentity = (): void => {
  setMockToken(null);
  identity += 1;
  setMockToken(`tok-${identity}`);
};

// The real class, not a lookalike: the latch reads `instanceof ApiError`.
const refuse = (status: number): Error => new ApiError(status, "bad_request");

// A name the server actually refuses. `"#"` was the issue's case before #2424
// made it a valid target, so using it here would read as a claim it no longer
// makes — any refused name works as a fixture.
const REFUSED = "bad name";

// One row, enough for the verbs that refuse to page an EMPTY pane.
const row = (id: number): ScrollbackMessage => ({
  id,
  network: "net",
  channel: REFUSED,
  server_time: id,
  kind: "privmsg",
  sender: "alice",
  body: `m${id}`,
  meta: {},
});

// A gap probe answer; `isFarBehind` is `gap > PAGE_LIMIT`.
const probe = (gap: number, events = 0): GapProbe => ({ gap, messages: gap - events, events });

// The page size the module ASKED for, read back off the wire rather than
// hardcoded: a `PAGE_LIMIT` that drifts would otherwise stop entering the
// full-page branch and the case would pass because it tested nothing.
const fullPageFor = (spy: { mock: { calls: unknown[][] } }): ScrollbackMessage[] => {
  const limit = spy.mock.calls[0]?.[4];
  if (typeof limit !== "number") throw new Error("no page limit observed on the wire");
  return Array.from({ length: limit }, (_, i) => row(i + 1));
};

// The latch line, counted off a `console.warn` spy. Nothing else in the suite
// reads `console.warn`, so before this case existed both the line and the
// early return in front of it could be deleted with the suite green.
const LATCH_LINE = "[scrollback] target refused, window latched";
const latchLines = (warn: { mock: { calls: unknown[][] } }): number =>
  warn.mock.calls.filter((call) => call[0] === LATCH_LINE).length;

// Hold a REST call open so another verb can run strictly inside its await.
const gate = <T>(): {
  promise: Promise<T>;
  release: (value: T) => void;
  fail: (e: Error) => void;
} => {
  let release!: (value: T) => void;
  let fail!: (e: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
};

describe("#2409 a refused target is not retried", () => {
  beforeEach(() => {
    listMessagesSpy.mockReset();
    listMessagesSpy.mockResolvedValue([]);
    listMessagesAfterSpy.mockReset();
    listMessagesAfterSpy.mockResolvedValue([]);
    countMessagesAfterSpy.mockReset();
    countMessagesAfterSpy.mockResolvedValue(probe(0));
    setReadCursorSpy.mockClear();
    freshIdentity();
  });

  it("does not re-fetch a cold load the server refused with 400", async () => {
    const { loadInitialScrollback } = await import("../lib/scrollback");
    listMessagesSpy.mockRejectedValue(refuse(400));

    await loadInitialScrollback("net", REFUSED);
    // The re-selection that used to replay the same refused GET.
    await loadInitialScrollback("net", REFUSED);

    expect(listMessagesSpy).toHaveBeenCalledTimes(1);
  });

  it("does not re-fetch a backfill the server refused with 400", async () => {
    const { refreshScrollback } = await import("../lib/scrollback");
    listMessagesAfterSpy.mockRejectedValue(refuse(400));

    await refreshScrollback("net", REFUSED);
    // Every join-ok and every reconnect sweep calls this verb again.
    await refreshScrollback("net", REFUSED);

    expect(listMessagesAfterSpy).toHaveBeenCalledTimes(1);
  });

  it("still retries a transient failure (control)", async () => {
    const { refreshScrollback } = await import("../lib/scrollback");
    listMessagesAfterSpy.mockRejectedValue(refuse(500));

    await refreshScrollback("net", REFUSED);
    await refreshScrollback("net", REFUSED);

    expect(listMessagesAfterSpy).toHaveBeenCalledTimes(2);
  });

  it("forgets the refusal on an identity change", async () => {
    const { refreshScrollback } = await import("../lib/scrollback");
    listMessagesAfterSpy.mockRejectedValue(refuse(400));
    await refreshScrollback("net", REFUSED);

    freshIdentity();
    await Promise.resolve(); // let the identity-scoped reset run
    listMessagesAfterSpy.mockResolvedValue([]);
    await refreshScrollback("net", REFUSED);

    expect(listMessagesAfterSpy).toHaveBeenCalledTimes(2);
  });

  // One case per verb, same shape as the two above. The reviewers measured
  // that removing BOTH the `loadMore` and the `loadNewer` guard left the
  // whole suite green (M34), so these two are the ones that actually pin
  // the latch rather than a neighbour's.

  it("does not re-fetch a loadMore the server refused with 400", async () => {
    const { loadInitialScrollback, loadMore } = await import("../lib/scrollback");
    // A pane with one row, so the verb gets past its empty-pane short-circuit.
    listMessagesSpy.mockResolvedValueOnce([row(1)]);
    await loadInitialScrollback("net", REFUSED);
    listMessagesSpy.mockRejectedValue(refuse(400));

    await loadMore("net", REFUSED, () => undefined);
    // Every scroll-to-top gesture asks again.
    await loadMore("net", REFUSED, () => undefined);

    // One cold load + exactly one refused backfill.
    expect(listMessagesSpy).toHaveBeenCalledTimes(2);
  });

  it("does not re-fetch a loadNewer the server refused with 400", async () => {
    const { loadInitialScrollback, loadNewer } = await import("../lib/scrollback");
    listMessagesSpy.mockResolvedValueOnce([row(1)]);
    await loadInitialScrollback("net", REFUSED);
    listMessagesAfterSpy.mockRejectedValue(refuse(400));

    await loadNewer("net", REFUSED);
    await loadNewer("net", REFUSED);

    expect(listMessagesAfterSpy).toHaveBeenCalledTimes(1);
  });

  // The latch line is the operator's only signal that a window went dead, and
  // `loadMore` / `loadNewer` used to leave none at all. It has to fire — once,
  // on the key's FIRST refusal, whoever the verb is — so this case pins both
  // halves: a second refused verb on the same key stays quiet.
  it("logs one latch line per key, on the first refusal", async () => {
    const { loadInitialScrollback, loadMore, refreshScrollback } = await import(
      "../lib/scrollback"
    );
    // A pane with a row, so `loadMore` gets past its empty-pane short-circuit.
    listMessagesSpy.mockResolvedValueOnce([row(1)]);
    await loadInitialScrollback("net", REFUSED);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // Two different verbs on the wire for the same key at once: `loadMore`
      // (listMessages) and `refreshScrollback` (listMessagesAfter), each held
      // open so the other is still in flight when the 400 lands.
      const backfill = gate<ScrollbackMessage[]>();
      const refresh = gate<ScrollbackMessage[]>();
      listMessagesSpy.mockReturnValueOnce(backfill.promise);
      listMessagesAfterSpy.mockReturnValueOnce(refresh.promise);
      const more = loadMore("net", REFUSED, () => undefined);
      const refreshing = refreshScrollback("net", REFUSED);

      backfill.fail(refuse(400));
      await more;
      refresh.fail(refuse(400));
      await refreshing;

      expect(latchLines(warn)).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  // The two jumps WRITE the latch in their catch but used to never read it on
  // the way in: every tap on the far-behind bar or on a mention row was one
  // more refused GET for the jail.
  it("does not put a refused target back on the wire from jumpToUnread", async () => {
    const { loadInitialScrollback, loadMore, refreshScrollback, jumpToUnread } = await import(
      "../lib/scrollback"
    );
    // `jumpToUnread` refuses on `!far` BEFORE it ever reads the latch, so a
    // case that starts from a latched-but-not-far-behind key passes with the
    // guard removed. The far-behind record has to come first: a full refresh
    // page whose probe says the remainder is more than a page.
    listMessagesSpy.mockResolvedValueOnce([row(1)]);
    await loadInitialScrollback("net", REFUSED);
    // The page has to be released AFTER the call is on the wire: its size is
    // read back from the limit the module asked for, and there is no call to
    // read it off until `refreshScrollback` has made one.
    const page = gate<ScrollbackMessage[]>();
    listMessagesAfterSpy.mockReturnValueOnce(page.promise);
    countMessagesAfterSpy.mockResolvedValueOnce(probe(400));
    listMessagesSpy.mockResolvedValueOnce([row(500)]);
    const refreshing = refreshScrollback("net", REFUSED);
    page.release(fullPageFor(listMessagesAfterSpy));
    await refreshing;

    // …and the latch from a verb that is not the cold load.
    listMessagesSpy.mockRejectedValue(refuse(400));
    await loadMore("net", REFUSED, () => undefined);
    listMessagesSpy.mockClear();
    listMessagesAfterSpy.mockClear();
    countMessagesAfterSpy.mockClear();

    expect(await jumpToUnread("net", REFUSED)).toBe(false);

    expect(listMessagesSpy).not.toHaveBeenCalled();
    expect(listMessagesAfterSpy).not.toHaveBeenCalled();
  });

  // `probeGap` reads the latch itself rather than trusting its callers: a
  // refresh reads the latch, then awaits its page, and a CONCURRENT verb can
  // latch the key inside that await. The probe is the next request the refresh
  // would spend, so it is the one the guard has to stop.
  it("does not probe a target another verb latched during the refresh", async () => {
    const { loadInitialScrollback, loadNewer, refreshScrollback } = await import(
      "../lib/scrollback"
    );
    // A pane with a row, so `loadNewer` gets past its empty-pane short-circuit.
    listMessagesSpy.mockResolvedValueOnce([row(1)]);
    await loadInitialScrollback("net", REFUSED);

    const page = gate<ScrollbackMessage[]>();
    listMessagesAfterSpy.mockReturnValueOnce(page.promise);
    const refreshing = refreshScrollback("net", REFUSED);

    // The concurrent verb latches the key while the refresh is in flight.
    listMessagesAfterSpy.mockRejectedValue(refuse(400));
    await loadNewer("net", REFUSED);

    // A FULL page: the shape that makes the refresh probe for the remainder.
    page.release(fullPageFor(listMessagesAfterSpy));
    await refreshing;

    expect(countMessagesAfterSpy).not.toHaveBeenCalled();
  });

  // #788 — the identity check lives inside `noteFetchFailure`, so a catch that
  // lands AFTER a rotation must not write into the new identity's set. The
  // existing rotation case covers a 400 that lands BEFORE it; this is the
  // other half.
  it("a 400 that lands after a rotation does not latch the new identity", async () => {
    const { refreshScrollback } = await import("../lib/scrollback");
    const page = gate<ScrollbackMessage[]>();
    listMessagesAfterSpy.mockReturnValueOnce(page.promise);
    const refreshing = refreshScrollback("net", REFUSED);

    freshIdentity();
    await Promise.resolve(); // let the identity-scoped reset run
    page.fail(refuse(400));
    await refreshing;

    listMessagesAfterSpy.mockResolvedValue([]);
    await refreshScrollback("net", REFUSED);

    expect(listMessagesAfterSpy).toHaveBeenCalledTimes(2);
  });

  // The latch is about the WIRE, not about the pane: a row already rendered
  // needs no request, and refusing that jump sends a mention tap to the marker
  // or the tail instead of to the mention. So the latch is read AFTER the
  // local hit.
  it("still jumps to a row already in the pane on a latched target", async () => {
    const { loadInitialScrollback, refreshScrollback, jumpToMessage } = await import(
      "../lib/scrollback"
    );
    listMessagesSpy.mockResolvedValueOnce([row(1)]);
    await loadInitialScrollback("net", REFUSED);
    listMessagesAfterSpy.mockRejectedValue(refuse(400));
    await refreshScrollback("net", REFUSED);
    listMessagesSpy.mockClear();
    listMessagesAfterSpy.mockClear();

    expect(await jumpToMessage("net", REFUSED, 1)).toBe(true);

    expect(listMessagesSpy).not.toHaveBeenCalled();
    expect(listMessagesAfterSpy).not.toHaveBeenCalled();
  });

  it("does not put a refused target back on the wire from jumpToMessage", async () => {
    const { loadInitialScrollback, jumpToMessage } = await import("../lib/scrollback");
    listMessagesSpy.mockRejectedValue(refuse(400));
    await loadInitialScrollback("net", REFUSED);
    listMessagesSpy.mockClear();
    listMessagesAfterSpy.mockClear();

    expect(await jumpToMessage("net", REFUSED, 42)).toBe(false);

    expect(listMessagesSpy).not.toHaveBeenCalled();
    expect(listMessagesAfterSpy).not.toHaveBeenCalled();
  });
});
