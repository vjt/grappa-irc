// Synthetic IRC peer for e2e tests.
//
// Wraps `irc-framework` in a small async/typed surface so specs read
// like a script: `await peer.join("#bofh")`, `await peer.privmsg(...)`.
// Each verb resolves only AFTER the upstream confirms the action
// (numeric or echo) — no `sleep` polling in test bodies.
//
// Connection target comes from E2E_IRC_HOST/E2E_IRC_PORT (set on the
// playwright-runner container in compose.yaml). The peer's nick is
// caller-supplied; the realname/username default to the same string
// because the testnet doesn't gate on either.
//
// One-peer-per-instance — `IrcPeer.connect` returns a connected client;
// `disconnect` tears it down. Pair `try/finally` in the spec to keep
// peer leaks out of the runner between tests.

import { Client } from "irc-framework";

const HOST = process.env.E2E_IRC_HOST ?? "bahamut-test";
const PORT = Number(process.env.E2E_IRC_PORT ?? "6667");

const REGISTER_TIMEOUT_MS = 10_000;
const JOIN_TIMEOUT_MS = 5_000;
const PART_TIMEOUT_MS = 5_000;

export class IrcPeer {
  private constructor(
    private readonly client: Client,
    public readonly nick: string,
  ) {}

  static async connect(opts: { nick: string }): Promise<IrcPeer> {
    const client = new Client();
    const peer = new IrcPeer(client, opts.nick);

    const registered = once(client, "registered", REGISTER_TIMEOUT_MS, `register ${opts.nick}`);

    client.connect({
      host: HOST,
      port: PORT,
      nick: opts.nick,
      username: opts.nick,
      gecos: opts.nick,
      auto_reconnect: false,
    });

    await registered;
    return peer;
  }

  async join(channel: string): Promise<void> {
    const joined = onceMatching(
      this.client,
      "join",
      (event: { nick: string; channel: string }) =>
        event.nick === this.nick && event.channel === channel,
      JOIN_TIMEOUT_MS,
      `join ${channel}`,
    );
    this.client.join(channel);
    await joined;
  }

  // Send a PRIVMSG to a target (channel or nick). Resolves once the
  // command is queued; `irc-framework` does not echo own messages back
  // by default, so callers that need delivery confirmation must observe
  // grappa-side state (DB / channel event) instead.
  privmsg(target: string, body: string): void {
    this.client.say(target, body);
  }

  async part(channel: string, reason: string): Promise<void> {
    const parted = onceMatching(
      this.client,
      "part",
      (event: { nick: string; channel: string }) =>
        event.nick === this.nick && event.channel === channel,
      PART_TIMEOUT_MS,
      `part ${channel}`,
    );
    this.client.part(channel, reason);
    await parted;
  }

  async disconnect(reason: string): Promise<void> {
    return new Promise((resolve) => {
      this.client.on("close", () => resolve());
      this.client.quit(reason);
    });
  }
}

function once(client: Client, event: string, timeoutMs: number, label: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`IrcPeer: timeout waiting for ${label} (${timeoutMs}ms)`)),
      timeoutMs,
    );
    client.once(event, (payload: unknown) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function onceMatching<T>(
  client: Client,
  event: string,
  predicate: (payload: T) => boolean,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`IrcPeer: timeout waiting for ${label} (${timeoutMs}ms)`)),
      timeoutMs,
    );
    const handler = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      client.removeListener(event, handler);
      resolve(payload);
    };
    client.on(event, handler);
  });
}
