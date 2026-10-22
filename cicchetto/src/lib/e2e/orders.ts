// issue 2430 "Authorising orders" — what an order challenge is checked
// against. A bot that takes orders from a pinned peer does not trust a
// plaintext line on its own: it sends the peer, inside the verified Olm
// session, a CHAL naming the line (`network`, `channel`, its SHA-256), and
// the peer's client answers ACK only if it sent exactly that line, on that
// network, in that channel, in the last 15 s. This module is the "it sent":
// the PRIVMSGs this device itself sent, as hashes, matched for 15 s.
//
// Written where cicchetto sends (`scrollback.ts` `sendMessage`), never from
// the echo: grappa echoes the lines every client of the user sends, and a
// line another client sent is exactly what the ACK must not confirm. It is
// the device's, not the tab's: any tab may drain the inbox the CHAL arrives
// in, so each tab tells the others what it sent. It keeps the body's hash,
// never the body: a NickServ password goes through the same send.
//
// One sent line confirms one challenge: the first CHAL that matches binds
// the line to its nonce, the same nonce again is answered again, and
// another nonce for the same line is not. The bot challenges every copy of
// a line it sees, so a copy someone else made in the user's nick inside the
// 15 s would otherwise run the order twice.
//
// Fail closed, by design (DESIGN_NOTES #2430w2c), and the bot then refuses
// the order once its challenge expires:
//   * a line grappa split into several PRIVMSGs: the bot hashes one of them;
//   * a line sent from another device or client, or another login in this
//     browser: only that one would know;
//   * a reload inside the 15 s: the log is memory;
//   * a network with no 005 `NETWORK=`, or a server before protocol 47: no
//     name to match the CHAL's `network` against.

import { isChannelName } from "../chantypes";
import type { Casemapping } from "../isupport";
import { nickEquals } from "../nickEquals";

/** How long a sent line can be confirmed: the bot's own challenge TTL (irc-olm). */
export const SENT_WINDOW_MS = 15_000;

/** The tag of an ACK: it has no row to mark, so what becomes of it is logged. */
export const ORDER_TAG = "order";

/** The account a line was sent from, as `kind:id`: the log matches it, so another login in this browser confirms nothing. */
export const subjectKey = (subject: { kind: string; id: string }): string =>
  `${subject.kind}:${subject.id}`;

/** A PRIVMSG this cic is sending: from `subject`, on the network `slug`, to `target` (a channel, or a nick). */
export type Sending = { subject: string; slug: string; target: string; body: string; at: number };

/** What the log keeps of a sent line: its hash, and the nonce of the challenge it confirmed (null: none yet). */
export type SentLine = {
  subject: string;
  slug: string;
  target: string;
  sha256: string;
  at: number;
  nonce: string | null;
};

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

/**
 * The network a challenge arrived on: whose account (`subjectKey`), its
 * slug, its 005 `NETWORK=` (null: none), its fold and its channel prefixes.
 */
export type OrderScope = {
  subject: string;
  slug: string;
  network: string | null;
  casemapping: Casemapping;
  chantypes: readonly string[];
};

/** What the log found for a challenge: only `confirmed` is answered. */
export type OrderVerdict =
  | "confirmed"
  | "unnamed-network"
  | "other-network"
  | "expired"
  | "pm-to-another"
  | "not-sent";

/** Why a challenge goes unanswered, as the console says it: what was seen, not a guess at intent. */
export const UNCONFIRMED: Record<Exclude<OrderVerdict, "confirmed">, string> = {
  "unnamed-network": "this network has sent no 005 NETWORK= name to match it against",
  "other-network": "it names another network",
  expired: "it has expired by this device's clock",
  "pm-to-another": "it names a private message to someone other than the bot asking",
  "not-sent": "this cic sent no such line there in the last 15 s, or it already confirmed it",
};

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

/** Lowercase hex SHA-256 of `body`, UTF-8: what a CHAL's `line_sha256` holds. */
async function sha256Hex(body: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(body)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

type Shared = { op: "record" | "forget" | "consume"; line: SentLine };

const OPS = new Set<unknown>(["record", "forget", "consume"]);

// What another tab posted, or null: a tab running another bundle after a
// deploy posts whatever shape that bundle had.
function sharedOf(data: unknown): Shared | null {
  if (typeof data !== "object" || data === null) return null;
  const { op, line } = data as Record<string, unknown>;
  if (!OPS.has(op) || typeof line !== "object" || line === null) return null;
  const l = line as Record<string, unknown>;
  const ok =
    typeof l.subject === "string" &&
    typeof l.slug === "string" &&
    typeof l.target === "string" &&
    typeof l.sha256 === "string" &&
    SHA256_HEX.test(l.sha256) &&
    Number.isSafeInteger(l.at) &&
    (l.nonce === null || typeof l.nonce === "string");
  return ok ? { op: op as Shared["op"], line: l as SentLine } : null;
}

// The same send, whatever challenge it has since confirmed.
const sameLine = (a: SentLine, b: SentLine): boolean =>
  a.subject === b.subject &&
  a.slug === b.slug &&
  a.target === b.target &&
  a.sha256 === b.sha256 &&
  a.at === b.at;

export class SendLog {
  private lines: SentLine[] = [];

  constructor(private readonly bus: BroadcastChannel | null) {
    bus?.addEventListener("message", (event: MessageEvent<unknown>) => {
      const shared = sharedOf(event.data);
      if (shared !== null) this.apply(shared);
    });
  }

  /**
   * This cic is sending `sending`: called before the send, so no CHAL can
   * come first. Returns what the log keeps, for `forget`.
   */
  async record(sending: Sending): Promise<SentLine> {
    const { body, ...rest } = sending;
    const line: SentLine = { ...rest, sha256: await sha256Hex(body), nonce: null };
    this.share({ op: "record", line });
    return line;
  }

  /** The send of `line` failed: it never went out, so nothing may confirm it. */
  forget(line: SentLine): void {
    this.share({ op: "forget", line });
  }

  /**
   * Whether this cic sent the line `chal` names, from the scope's account,
   * on its network, in the last `SENT_WINDOW_MS` before `at`, with the
   * challenge still live. A confirmed line is bound to the challenge's
   * nonce. The network name must match exactly, and a network with none
   * matches nothing. A private message must have gone to the bot asking,
   * `challenger`: the CHAL's `channel` is then the bot's own nick.
   */
  confirms(chal: Challenge, challenger: string, scope: OrderScope, at: number): OrderVerdict {
    if (scope.network === null) return "unnamed-network";
    if (chal.network !== scope.network) return "other-network";
    if (at >= chal.expiresAt * 1000) return "expired";
    if (
      !isChannelName(chal.channel, scope.chantypes) &&
      !nickEquals(chal.channel, challenger, scope.casemapping)
    ) {
      return "pm-to-another";
    }
    this.prune(at);
    const named = (l: SentLine) =>
      l.subject === scope.subject &&
      l.slug === scope.slug &&
      l.at <= at &&
      l.sha256 === chal.lineSha256 &&
      nickEquals(l.target, chal.channel, scope.casemapping);
    const again = this.lines.find((l) => named(l) && l.nonce === chal.nonce);
    if (again !== undefined) return "confirmed";
    const fresh = this.lines.find((l) => named(l) && l.nonce === null);
    if (fresh === undefined) return "not-sent";
    this.share({ op: "consume", line: { ...fresh, nonce: chal.nonce } });
    return "confirmed";
  }

  private share(message: Shared): void {
    this.apply(message);
    this.bus?.postMessage(message);
  }

  private apply({ op, line }: Shared): void {
    switch (op) {
      case "record":
        this.prune(line.at);
        this.lines.push(line);
        return;
      case "forget":
        this.lines = this.lines.filter((l) => !sameLine(l, line));
        return;
      case "consume":
        this.lines = this.lines.map((l) =>
          sameLine(l, line) && l.nonce === null ? { ...l, nonce: line.nonce } : l,
        );
        return;
    }
  }

  // Lines past the window are dropped at the next record or check: they
  // can confirm nothing, and the log holds no body.
  private prune(at: number): void {
    this.lines = this.lines.filter((l) => at - l.at <= SENT_WINDOW_MS);
  }
}

/** The device's send log: every tab's, shared over a BroadcastChannel. */
export const sendLog = new SendLog(
  typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("grappa-e2e-sent"),
);
