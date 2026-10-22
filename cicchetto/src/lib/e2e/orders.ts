// issue 2430 "Authorising orders" — what an order challenge is checked
// against. A bot that takes orders from a pinned peer does not trust a
// plaintext line on its own: it sends the peer, inside the verified Olm
// session, a CHAL naming the line (`network`, `channel`, its SHA-256), and
// the peer's client answers ACK only if it sent exactly that line, on that
// network, in that channel, in the last 15 s. This module is the "it sent":
// the PRIVMSGs this device itself sent, kept in memory for 15 s.
//
// Written where cicchetto sends (`scrollback.ts` `sendMessage`), never from
// the echo: grappa echoes the lines every client of the user sends, and a
// line another client sent is exactly what the ACK must not confirm. It is
// the device's, not the tab's: any tab may drain the inbox the CHAL arrives
// in, so each tab tells the others what it sent.
//
// Fail closed, by design (DESIGN_NOTES #2430w2c), and the bot then refuses
// the order once its challenge expires:
//   * a line grappa split into several PRIVMSGs: the bot hashes one of them;
//   * a line sent from another device or client: only this one would know;
//   * a reload inside the 15 s: the log is memory;
//   * a network with no 005 `NETWORK=`, or a server before protocol 47: no
//     name to match the CHAL's `network` against.

import type { Casemapping } from "../isupport";
import { nickEquals } from "../nickEquals";

/** How long a sent line can be confirmed: the bot's own challenge TTL (irc-olm). */
export const SENT_WINDOW_MS = 15_000;

/** The tag of an ACK: it has no row to mark, so what becomes of it is logged. */
export const ORDER_TAG = "order";

/** A PRIVMSG this cic sent: on the network `slug`, to `target` (a channel, or a nick). */
export type SentLine = { slug: string; target: string; body: string; at: number };

/** An order challenge, the inner `{t: "chal", …}` irc-olm's `Challenge.inner()` builds. */
export type Challenge = {
  /** The bot's 005 `NETWORK=` token: not grappa's slug. */
  network: string;
  /** The raw PRIVMSG target the bot received: a channel, or its own nick. */
  channel: string;
  senderMask: string;
  /** Lowercase hex SHA-256 of the PRIVMSG body, UTF-8. */
  lineSha256: string;
  nonce: string;
  /** Unix seconds, on the bot's clock. */
  expiresAt: number;
};

/** The network a challenge arrived on: its slug, its 005 `NETWORK=` (null: none), its fold. */
export type OrderScope = { slug: string; network: string | null; casemapping: Casemapping };

const SHA256_HEX = /^[0-9a-f]{64}$/;

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";

/** The challenge in `inner`, or null when it is not a well-formed CHAL. */
export function parseChallenge(inner: Record<string, unknown>): Challenge | null {
  const { t, network, channel, sender_mask, line_sha256, nonce, expires_at } = inner;
  if (
    t !== "chal" ||
    !nonEmpty(network) ||
    !nonEmpty(channel) ||
    typeof sender_mask !== "string" ||
    typeof line_sha256 !== "string" ||
    !SHA256_HEX.test(line_sha256) ||
    !nonEmpty(nonce) ||
    !Number.isSafeInteger(expires_at)
  ) {
    return null;
  }
  return {
    network,
    channel,
    senderMask: sender_mask,
    lineSha256: line_sha256,
    nonce,
    expiresAt: expires_at as number,
  };
}

const encoder = new TextEncoder();

async function sha256Hex(body: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(body)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

type Shared = { op: "record" | "forget"; line: SentLine };

const sameLine = (a: SentLine, b: SentLine): boolean =>
  a.slug === b.slug && a.target === b.target && a.body === b.body && a.at === b.at;

export class SendLog {
  private lines: SentLine[] = [];

  constructor(private readonly channel: BroadcastChannel | null) {
    channel?.addEventListener("message", (event: MessageEvent<Shared>) => this.apply(event.data));
  }

  /** This cic is sending `line`: before the send, so no CHAL can come first. */
  record(line: SentLine): void {
    this.share({ op: "record", line });
  }

  /** The send of `line` failed: it never went out, so nothing may confirm it. */
  forget(line: SentLine): void {
    this.share({ op: "forget", line });
  }

  /**
   * Whether this cic sent the line `chal` names, on the scope's network, in
   * the last `SENT_WINDOW_MS` before `at`, with the challenge still live.
   * The network name must match exactly, and a network with none matches
   * nothing.
   */
  async confirms(chal: Challenge, scope: OrderScope, at: number): Promise<boolean> {
    if (scope.network === null || chal.network !== scope.network) return false;
    if (at >= chal.expiresAt * 1000) return false;
    this.prune(at);
    for (const line of this.lines) {
      if (
        line.slug === scope.slug &&
        line.at <= at &&
        nickEquals(line.target, chal.channel, scope.casemapping) &&
        (await sha256Hex(line.body)) === chal.lineSha256
      ) {
        return true;
      }
    }
    return false;
  }

  private share(message: Shared): void {
    this.apply(message);
    this.channel?.postMessage(message);
  }

  private apply({ op, line }: Shared): void {
    if (op === "record") {
      this.prune(line.at);
      this.lines.push(line);
    } else {
      this.lines = this.lines.filter((l) => !sameLine(l, line));
    }
  }

  private prune(at: number): void {
    this.lines = this.lines.filter((l) => at - l.at <= SENT_WINDOW_MS);
  }
}

/** The device's send log: every tab's, shared over a BroadcastChannel. */
export const sendLog = new SendLog(
  typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("grappa-e2e-sent"),
);
