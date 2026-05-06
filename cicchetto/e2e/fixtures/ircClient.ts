// Synthetic IRC peer for e2e tests — raw client over `node:net`.
//
// Why not irc-framework: it unconditionally writes `CAP LS 302` before
// NICK/USER (irc-framework/src/client.js:330). Bahamut (the testnet
// hub) silently discards CAP for non-registered clients (parse.c only
// emits 421 to IsPerson; pre-registration the CAP line is processed,
// throttled, and never replied to). irc-framework then sits waiting
// for a `CAP * LS :…` reply that never arrives, while bahamut quietly
// processes NICK/USER and stalls completion of registration until the
// 30-second `CONNECTTIMEOUT` in check_pings forces SetAccess. End
// result: bahamut welcome arrives ~30s late, blowing past Playwright's
// register timeout.
//
// We don't need any IRCv3 cap (no SASL — testnet is `--auth none`),
// so we sidestep the whole cap-negotiation by writing only NICK +
// USER, then waiting for the 001 RPL_WELCOME numeric.
//
// Connection target comes from E2E_IRC_HOST/E2E_IRC_PORT (set on the
// playwright-runner container in compose.yaml). The peer's nick is
// caller-supplied; the username/realname default to the same string.
//
// One-peer-per-instance — `IrcPeer.connect` returns a connected client;
// `disconnect` tears it down. Pair `try/finally` in the spec to keep
// peer leaks out of the runner between tests.

import { Socket, connect } from "node:net";
import { EventEmitter } from "node:events";

const HOST = process.env.E2E_IRC_HOST ?? "bahamut-test";
const PORT = Number(process.env.E2E_IRC_PORT ?? "6667");

const REGISTER_TIMEOUT_MS = 10_000;
const JOIN_TIMEOUT_MS = 5_000;
const PART_TIMEOUT_MS = 5_000;
const DISCONNECT_TIMEOUT_MS = 3_000;

// Parsed IRC line — the subset of the RFC1459 grammar we care about
// for fixture verbs. `prefix` is the bare nick when the source is a
// user (`:nick!user@host`), undefined otherwise.
type Line = {
  prefix: string | undefined;
  command: string;
  params: string[];
};

export class IrcPeer {
  private readonly emitter = new EventEmitter();
  private readBuffer = "";

  private constructor(
    private readonly socket: Socket,
    public readonly nick: string,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.feed(chunk));
  }

  static async connect(opts: { nick: string }): Promise<IrcPeer> {
    const socket = connect({ host: HOST, port: PORT });
    socket.setNoDelay(true);
    const peer = new IrcPeer(socket, opts.nick);

    const ready = peer.waitFor(
      (line) => line.command === "001",
      REGISTER_TIMEOUT_MS,
      `register ${opts.nick}`,
    );

    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });

    socket.write(`NICK ${opts.nick}\r\n`);
    socket.write(`USER ${opts.nick} 0 * :${opts.nick}\r\n`);

    await ready;
    return peer;
  }

  async join(channel: string): Promise<void> {
    const joined = this.waitFor(
      (line) =>
        line.command === "JOIN" &&
        line.prefix === this.nick &&
        line.params[0] === channel,
      JOIN_TIMEOUT_MS,
      `join ${channel}`,
    );
    this.socket.write(`JOIN ${channel}\r\n`);
    await joined;
  }

  // Send a PRIVMSG. Resolves once the bytes are flushed to the socket;
  // bahamut does not echo own messages back, so callers that need
  // delivery confirmation must observe grappa-side state (REST /
  // channel events) instead.
  privmsg(target: string, body: string): void {
    this.socket.write(`PRIVMSG ${target} :${body}\r\n`);
  }

  async part(channel: string, reason: string): Promise<void> {
    const parted = this.waitFor(
      (line) =>
        line.command === "PART" &&
        line.prefix === this.nick &&
        line.params[0] === channel,
      PART_TIMEOUT_MS,
      `part ${channel}`,
    );
    this.socket.write(`PART ${channel} :${reason}\r\n`);
    await parted;
  }

  async disconnect(reason: string): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), DISCONNECT_TIMEOUT_MS);
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.write(`QUIT :${reason}\r\n`);
      this.socket.end();
    });
  }

  private feed(chunk: string): void {
    this.readBuffer += chunk;
    let idx = this.readBuffer.indexOf("\r\n");
    while (idx !== -1) {
      const raw = this.readBuffer.slice(0, idx);
      this.readBuffer = this.readBuffer.slice(idx + 2);
      const line = parse(raw);
      if (line.command === "PING") {
        this.socket.write(`PONG :${line.params[0] ?? ""}\r\n`);
      }
      this.emitter.emit("line", line);
      idx = this.readBuffer.indexOf("\r\n");
    }
  }

  private waitFor(
    predicate: (line: Line) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<Line> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.emitter.removeListener("line", handler);
          reject(new Error(`IrcPeer: timeout waiting for ${label} (${timeoutMs}ms)`));
        },
        timeoutMs,
      );
      const handler = (line: Line) => {
        if (!predicate(line)) return;
        clearTimeout(timer);
        this.emitter.removeListener("line", handler);
        resolve(line);
      };
      this.emitter.on("line", handler);
    });
  }
}

// RFC1459 line parser. Single trailing-param ":..." segment captured
// as one element. Prefix is sliced down to the bare nick when present
// (everything before `!`); when no `!` we keep the whole prefix (server
// numeric source).
function parse(raw: string): Line {
  let cursor = 0;
  let prefix: string | undefined;

  if (raw[cursor] === ":") {
    const space = raw.indexOf(" ", cursor);
    const full = raw.slice(1, space);
    const bang = full.indexOf("!");
    prefix = bang === -1 ? full : full.slice(0, bang);
    cursor = space + 1;
  }

  const params: string[] = [];
  let command = "";
  let cmdEnd = raw.indexOf(" ", cursor);
  if (cmdEnd === -1) {
    command = raw.slice(cursor);
    return { prefix, command, params };
  }
  command = raw.slice(cursor, cmdEnd);
  cursor = cmdEnd + 1;

  while (cursor < raw.length) {
    if (raw[cursor] === ":") {
      params.push(raw.slice(cursor + 1));
      break;
    }
    const space = raw.indexOf(" ", cursor);
    if (space === -1) {
      params.push(raw.slice(cursor));
      break;
    }
    params.push(raw.slice(cursor, space));
    cursor = space + 1;
  }

  return { prefix, command, params };
}
