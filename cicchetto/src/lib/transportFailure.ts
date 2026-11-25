// issue 2738 — the transport half of the request failure union: what a
// request ends with when the SERVER never said yes or no.
//
// The server-answered members are `ApiError` (REST) and `ChannelPushError`
// (WS push), both in `api.ts`. These live apart from them on purpose: they
// are produced by the transport, not decoded from a server envelope, and 64
// test files mock `lib/api` with a factory — a class defined there would need
// a hand-copied stub in every mock that reaches an `instanceof`, a second
// definition free to drift from this one.

// How long a client→server request waits for its answer.
//
// ONE deadline for both doors (vjt's D1 on issue 2738), placed ABOVE the
// longest wait the server itself bounds: the Repo caller deadline in
// `config/runtime.exs` (the `timeout:` rung of the contention ladder), which a
// DB-writing channel verb such as `watchlist` can spend in full before it
// replies. The number is not restated here: when that rung moves, this one has
// to stay above it. A client deadline below the server's is a lie — it
// declares "no answer" for a request the server is about to answer, or has
// already committed. phoenix's own default (10 s) sat below it.
export const REPLY_DEADLINE_MS = 20_000;

// The request got NO answer by its deadline. The outcome is UNKNOWN, never
// "failed": the request may never have left (phoenix drops a buffered push
// that times out before the channel rejoins), may have been executed with the
// reply lost, or may be answered after the deadline (phoenix unbinds the reply
// listener at the timeout, so a late reply is dropped). Copy has to say so;
// see `friendlyError`.
export class NoReply extends Error {
  readonly deadlineMs: number;

  constructor(deadlineMs: number) {
    super(`no reply within ${deadlineMs} ms`);
    this.name = "NoReply";
    this.deadlineMs = deadlineMs;
  }
}

// The request is KNOWN not sent: there is no user channel to push on (before
// the first `joinUser`, or after a logout).
export class NotConnected extends Error {
  constructor() {
    super("not connected");
    this.name = "NotConnected";
  }
}
