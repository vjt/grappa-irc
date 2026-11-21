// PR 2688 F7 — the disconnect must not wait for a "close" the client will
// never emit again. Runs under the cic vitest project (vitest.config.ts):
// `peerClose.ts` is free of the e2e-only `irc-framework` dependency.
//
// The fake reproduces the library behaviour that was MEASURED (irc-framework
// 4.14.0 against a fake ircd, see `peerClose.ts`): the first `quit()` closes
// and "close" fires once; after that, `quit()` closes nothing and "close"
// never fires again.

import { describe, expect, it } from "vitest";
import { type CloseSource, disconnectOnce } from "./peerClose";

type FakeClient = CloseSource & { quits: () => string[]; serverCloses: () => void };

function fakeClient(): FakeClient {
  const handlers: Array<() => void> = [];
  const quits: string[] = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const handler of [...handlers]) handler();
  };
  return {
    on: (_event, handler) => {
      handlers.push(handler);
    },
    quit: (message) => {
      quits.push(message ?? "");
      queueMicrotask(close);
    },
    quits: () => quits,
    serverCloses: close,
  };
}

// A settled promise answers "resolved"; one still pending after `ms` answers
// "pending". The pending branch is what the old disconnect did on its second
// call, so it must be reachable: the control below proves it is.
function settles(p: Promise<void>, ms: number): Promise<"resolved" | "pending"> {
  return Promise.race([
    p.then(() => "resolved" as const),
    new Promise<"pending">((r) => setTimeout(() => r("pending"), ms)),
  ]);
}

describe("disconnectOnce (PR 2688 F7)", () => {
  it("the oracle can see a disconnect that never settles", async () => {
    expect(await settles(new Promise(() => {}), 50)).toBe("pending");
  });

  it("a live client is quit once and the disconnect resolves on its close", async () => {
    const client = fakeClient();
    const disconnect = disconnectOnce(client);
    expect(await settles(disconnect("first"), 200)).toBe("resolved");
    expect(client.quits()).toEqual(["first"]);
  });

  it("a second disconnect resolves at once and sends no second QUIT", async () => {
    const client = fakeClient();
    const disconnect = disconnectOnce(client);
    await disconnect("in the body");
    expect(await settles(disconnect("in finally"), 200)).toBe("resolved");
    expect(client.quits()).toEqual(["in the body"]);
  });

  it("a client the server already closed is not quit, and the disconnect resolves", async () => {
    const client = fakeClient();
    const disconnect = disconnectOnce(client);
    client.serverCloses();
    expect(await settles(disconnect("after a kill"), 200)).toBe("resolved");
    expect(client.quits()).toEqual([]);
  });
});
