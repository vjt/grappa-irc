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
import type { ScrollbackMessage } from "../lib/api";
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
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    listMessages: (...args: unknown[]) => listMessagesSpy(...args),
    listMessagesAfter: (...args: unknown[]) => listMessagesAfterSpy(...args),
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

describe("#2409 a refused target is not retried", () => {
  beforeEach(() => {
    listMessagesSpy.mockReset();
    listMessagesSpy.mockResolvedValue([]);
    listMessagesAfterSpy.mockReset();
    listMessagesAfterSpy.mockResolvedValue([]);
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

  // The two jumps WRITE the latch in their catch but used to never read it on
  // the way in: every tap on the far-behind bar or on a mention row was one
  // more refused GET for the jail.
  it("does not put a refused target back on the wire from jumpToUnread", async () => {
    const { loadInitialScrollback, jumpToUnread } = await import("../lib/scrollback");
    listMessagesSpy.mockRejectedValue(refuse(400));
    await loadInitialScrollback("net", REFUSED);
    listMessagesSpy.mockClear();
    listMessagesAfterSpy.mockClear();

    expect(await jumpToUnread("net", REFUSED)).toBe(false);

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
