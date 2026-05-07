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
const NICK_TIMEOUT_MS = 5_000;
const MODE_TIMEOUT_MS = 5_000;
const KICK_TIMEOUT_MS = 5_000;
const OPER_TIMEOUT_MS = 5_000;

export class IrcPeer {
  private readonly client: Client;

  // Public so callers can derive locator strings from the live nick.
  // Mutable because `changeNick` updates it after a successful upstream
  // rename — readonly would force callers to thread the new value
  // manually for every post-rename verb.
  public nick: string;

  private constructor(client: Client, nick: string) {
    this.client = client;
    this.nick = nick;
  }

  static async connect(opts: { nick: string }): Promise<IrcPeer> {
    const client = new Client();
    const peer = new IrcPeer(client, opts.nick);

    // Diagnostic: surface every irc-framework event during register so a
    // timeout failure shows what bahamut sent (RPL_*, ERR_*, NOTICE,
    // socket close, etc.) instead of just "timeout". `raw` fires for
    // every wire-line; we tag with the nick so multiple parallel peers
    // don't blur in the log.
    if (process.env.E2E_PEER_DEBUG === "1") {
      client.on("raw", (event: { line: string; from_server: boolean }) => {
        if (!event.from_server) return;
        // eslint-disable-next-line no-console
        console.log(`[peer:${opts.nick}] <- ${event.line}`);
      });
      client.on("socket close", () => {
        // eslint-disable-next-line no-console
        console.log(`[peer:${opts.nick}] socket close`);
      });
    }

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

  // Send a CTCP ACTION (the wire shape of `/me text`). Same fire-and-
  // queue semantics as `privmsg` — `irc-framework` doesn't echo own
  // commands, observe grappa state for delivery confirmation.
  action(target: string, body: string): void {
    this.client.action(target, body);
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

  // Set channel modes. Resolves once upstream echoes the MODE event for
  // the target channel matching the requested raw_modes string.
  // Examples: `mode("#chan", "+i")`, `mode("#chan", "+o", "nick")`,
  // `mode("#chan", "+b", "*!*@evil")`. Param-bearing modes accept a
  // single extra arg (matching irc-framework's `mode(ch, m, extra_args)`
  // signature; arrays are also accepted by the lib for batched ops).
  //
  // Predicate matches `raw_modes` rather than the parsed `modes` array
  // because some servers (bahamut included) echo the modes back with
  // adjacent-mode-letter packing (`+ot`) where the test asked for `+o`
  // alone — `raw_modes.includes(rawModes.replace(/^[+-]/, ''))` would
  // be a stricter check, but for our use sites (single-letter modes)
  // the literal echo is reliable enough.
  async mode(channel: string, rawModes: string, extraArg?: string): Promise<void> {
    const modeEcho = onceMatching(
      this.client,
      "mode",
      (event: { target: string; raw_modes: string }) =>
        event.target === channel && event.raw_modes === rawModes,
      MODE_TIMEOUT_MS,
      `mode ${channel} ${rawModes}${extraArg ? " " + extraArg : ""}`,
    );
    this.client.mode(channel, rawModes, extraArg);
    await modeEcho;
  }

  // KICK a target nick from a channel with a reason. Resolves once
  // upstream echoes the KICK on the channel topic. Caller must be op
  // (`+o`) on the channel — bahamut otherwise emits 482
  // ERR_CHANOPRIVSNEEDED and this resolves never (the test times out).
  async kick(channel: string, target: string, reason: string): Promise<void> {
    const kicked = onceMatching(
      this.client,
      "kick",
      (event: { nick: string; kicked: string; channel: string }) =>
        event.nick === this.nick && event.kicked === target && event.channel === channel,
      KICK_TIMEOUT_MS,
      `kick ${channel} ${target}`,
    );
    this.client.raw(["KICK", channel, target, reason]);
    await kicked;
  }

  // /OPER up to ircop. Required to bypass bahamut's "no ops on new
  // channels in split-mode" gate that otherwise locks every freshly
  // created channel out of any kind of mode-setting (including +i, +k,
  // +o). Resolves on 381 RPL_YOUREOPER.
  //
  // Reason this matters for e2e: the testnet leaf isn't S2S-linked to
  // the hub at the time peer clients connect (255 reports `0 servers`),
  // so bahamut keeps the leaf in split-mode permanently — fresh JOINers
  // never auto-op. Without ircop bypass, the peer can JOIN but cannot
  // MODE +i / MODE +o anyone, including itself. With +O (and the
  // configured `OaARD` flagset on the leaf's O: line), ircops issue
  // MODE / SAMODE freely on any channel they're in.
  async oper(name: string, password: string): Promise<void> {
    const opered = once(
      this.client,
      "rpl_youreoper",
      OPER_TIMEOUT_MS,
      `oper ${name}`,
    );
    this.client.raw(["OPER", name, password]);
    await opered;
  }

  // Change own nick. Resolves after the upstream `nick` event with
  // matching old→new transition. Updates `this.nick` so subsequent
  // verbs use the new nick. The `irc-framework` event payload is
  // `{nick: oldNick, new_nick: newNick}` per the lib's own naming.
  async changeNick(newNick: string): Promise<void> {
    const oldNick = this.nick;
    const renamed = onceMatching(
      this.client,
      "nick",
      (event: { nick: string; new_nick: string }) =>
        event.nick === oldNick && event.new_nick === newNick,
      NICK_TIMEOUT_MS,
      `nick ${oldNick} → ${newNick}`,
    );
    this.client.changeNick(newNick);
    await renamed;
    this.nick = newNick;
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
