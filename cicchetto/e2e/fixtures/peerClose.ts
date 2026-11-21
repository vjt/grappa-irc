// PR 2688 F7 — `IrcPeer.disconnect`, made safe to call on a peer that has
// already closed.
//
// irc-framework emits "close" ONCE. On the way out, `socketClose` in its
// connection.js strips the transport's listeners and then emits; a second
// `quit()` closes a dead transport that nothing listens to any more. So a
// promise waiting for "close" after the first one waits for ever. Measured
// against irc-framework 4.14.0 and a fake ircd that answers QUIT the way
// bahamut does (ERROR, then it closes): the first disconnect resolved in
// 1 ms, the second never did. That is what hung issue 2656's E1 in CI: a
// disconnect in the body, a second one in `finally`, then the 150 s test
// timeout. Every spec that pairs a body disconnect with a `finally` one,
// or whose peer the server closed, walks into the same trap.
//
// Kept apart from `ircClient.ts` because that module imports the e2e-only
// `irc-framework`, and this logic has to be unit-testable under the cic
// vitest project (the reason `privmsgWait.ts` and `whoisWait.ts` are split
// out the same way).

// The slice of irc-framework's `Client` the disconnect needs.
export type CloseSource = {
  on(event: "close", handler: () => void): unknown;
  quit(message?: string): void;
};

// Returns the disconnect for `client`. It must be built BEFORE anything can
// close the client, so its own "close" listener records the first one.
// `IrcPeer.connect` passes `auto_reconnect: false`, so that first "close"
// is final: the flag, written by the library's own event, is the whole
// state. On a client already closed — by an earlier disconnect or by the
// server — it resolves at once and sends nothing.
export function disconnectOnce(client: CloseSource): (reason: string) => Promise<void> {
  let closed = false;
  client.on("close", () => {
    closed = true;
  });
  return (reason) => {
    if (closed) return Promise.resolve();
    return new Promise((resolve) => {
      client.on("close", () => resolve());
      client.quit(reason);
    });
  };
}
