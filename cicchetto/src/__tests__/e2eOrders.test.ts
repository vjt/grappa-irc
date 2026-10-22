// issue 2430 "Authorising orders" — the send log an order challenge is
// checked against: cicchetto ACKs a CHAL only for a line THIS cic sent, on
// that network, in that channel, in the last 15 s, once.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type Challenge,
  type OrderScope,
  parseChallenge,
  SENT_WINDOW_MS,
  type Sending,
  SendLog,
} from "../lib/e2e/orders";

const AT = 1_700_000_000_000;
const BOT = "i2430-bot";
const SCOPE: OrderScope = {
  subject: "user:0b5e",
  slug: "azzurra",
  network: "AzzurraNet",
  casemapping: "ascii",
  chantypes: ["#", "&"],
};
const LINE: Sending = {
  subject: "user:0b5e",
  slug: "azzurra",
  target: "#grappa",
  body: "i2430-bot: ping",
  at: AT,
};

// The bot's hash, by an implementation that is not the one under test.
const sha256 = (body: string): string => createHash("sha256").update(body, "utf8").digest("hex");

const chalFor = (line: Sending, over: Partial<Challenge> = {}): Challenge => ({
  network: "AzzurraNet",
  channel: line.target,
  senderMask: "vjt!~vjt@azzurra.example",
  lineSha256: sha256(line.body),
  nonce: "bm9uY2Uwbm9uY2Uw",
  expiresAt: Math.floor(AT / 1000) + 15,
  ...over,
});

const logWith = async (...lines: Sending[]): Promise<SendLog> => {
  const log = new SendLog(null);
  for (const line of lines) await log.record(line);
  return log;
};

describe("SendLog.confirms", () => {
  it("confirms a line this cic sent there, inside the window", async () => {
    const log = await logWith(LINE);
    expect(log.confirms(chalFor(LINE), BOT, SCOPE, AT + 2_000)).toBe("confirmed");
    // The window's own edge, under a challenge that lives past it.
    const later = chalFor(LINE, { expiresAt: Math.floor(AT / 1000) + 30, nonce: "bGF0ZXI" });
    expect((await logWith(LINE)).confirms(later, BOT, SCOPE, AT + SENT_WINDOW_MS)).toBe(
      "confirmed",
    );
  });

  it("matches the channel as the network folds it, and a plaintext PM by the bot's nick", async () => {
    const pm: Sending = { ...LINE, target: "i2430-Bot", body: "status" };
    const log = await logWith(LINE, pm);
    expect(log.confirms(chalFor(LINE, { channel: "#GRAPPA" }), BOT, SCOPE, AT)).toBe("confirmed");
    expect(log.confirms(chalFor(pm, { channel: "I2430-bot" }), BOT, SCOPE, AT)).toBe("confirmed");
  });

  it("refuses a PM challenge that names someone other than the bot asking", async () => {
    const pm: Sending = { ...LINE, target: "carol", body: "the code is 1234" };
    const log = await logWith(pm);
    expect(log.confirms(chalFor(pm), BOT, SCOPE, AT)).toBe("pm-to-another");
    expect(log.confirms(chalFor(pm), "Carol", SCOPE, AT)).toBe("confirmed");
  });

  it("hashes the body as UTF-8 bytes", async () => {
    const line: Sending = { ...LINE, body: "i2430-bot: è così 🔐" };
    expect((await logWith(line)).confirms(chalFor(line), BOT, SCOPE, AT)).toBe("confirmed");
  });

  it("names why it stays silent for anything this cic did not send just there, just then", async () => {
    const refused: [string, Challenge, OrderScope, number, string][] = [
      ["another line", chalFor({ ...LINE, body: "i2430-bot: pong" }), SCOPE, AT, "not-sent"],
      ["another channel", chalFor(LINE, { channel: "#grappa2" }), SCOPE, AT, "not-sent"],
      ["another network's slug", chalFor(LINE), { ...SCOPE, slug: "libera" }, AT, "not-sent"],
      ["another login", chalFor(LINE), { ...SCOPE, subject: "user:5ca1" }, AT, "not-sent"],
      [
        "another network's name",
        chalFor(LINE, { network: "Libera.Chat" }),
        SCOPE,
        AT,
        "other-network",
      ],
      [
        "a name differing in case",
        chalFor(LINE, { network: "azzurranet" }),
        SCOPE,
        AT,
        "other-network",
      ],
      ["a network with no name", chalFor(LINE), { ...SCOPE, network: null }, AT, "unnamed-network"],
      [
        "a line older than the window",
        chalFor(LINE, { expiresAt: Math.floor(AT / 1000) + 30 }),
        SCOPE,
        AT + SENT_WINDOW_MS + 1,
        "not-sent",
      ],
      ["a line sent after the check", chalFor(LINE), SCOPE, AT - 1, "not-sent"],
      [
        "a challenge already expired",
        chalFor(LINE, { expiresAt: AT / 1000 }),
        SCOPE,
        AT,
        "expired",
      ],
    ];
    for (const [what, chal, scope, at, verdict] of refused) {
      expect((await logWith(LINE)).confirms(chal, BOT, scope, at), what).toBe(verdict);
    }
  });

  it("one sent line confirms one challenge; the same challenge again is answered again", async () => {
    const log = await logWith(LINE);
    const first = chalFor(LINE, { nonce: "Zmlyc3Q" });
    const second = chalFor(LINE, { nonce: "c2Vjb25k" });
    expect(log.confirms(first, BOT, SCOPE, AT)).toBe("confirmed");
    expect(log.confirms(second, BOT, SCOPE, AT)).toBe("not-sent");
    expect(log.confirms(first, BOT, SCOPE, AT)).toBe("confirmed");
    // Two sends of the same text are two lines: two challenges confirmed.
    const twice = await logWith(LINE, { ...LINE, at: AT + 1 });
    expect(twice.confirms(first, BOT, SCOPE, AT + 1)).toBe("confirmed");
    expect(twice.confirms(second, BOT, SCOPE, AT + 1)).toBe("confirmed");
  });

  it("a forgotten line confirms nothing (its send failed)", async () => {
    const log = new SendLog(null);
    const kept = await log.record(LINE);
    log.forget(kept);
    expect(log.confirms(chalFor(LINE), BOT, SCOPE, AT)).toBe("not-sent");
  });

  it("another tab's send, forget and confirmation count: the log is the device's", async () => {
    const name = `grappa-e2e-sent-test-${Math.random()}`;
    const buses = [0, 1, 2].map(() => new BroadcastChannel(name));
    try {
      const [here, there] = buses.slice(0, 2).map((bus) => new SendLog(bus)) as [SendLog, SendLog];
      // `confirms` consumes, so it cannot be polled to see a message arrive:
      // a third tab watches the bus instead.
      const ops: string[] = [];
      buses[2]?.addEventListener("message", (e) => ops.push((e.data as { op: string }).op));
      const kept = await here.record(LINE);
      await expect
        .poll(() => there.confirms(chalFor(LINE), BOT, SCOPE, AT), { timeout: 1_000 })
        .toBe("confirmed");
      // There confirmed it: once here has heard so, another challenge for it is refused.
      await expect.poll(() => ops, { timeout: 1_000 }).toContain("consume");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(here.confirms(chalFor(LINE, { nonce: "b3RoZXI" }), BOT, SCOPE, AT)).toBe("not-sent");
      here.forget(kept);
      await expect
        .poll(() => there.confirms(chalFor(LINE), BOT, SCOPE, AT), { timeout: 1_000 })
        .toBe("not-sent");
    } finally {
      for (const bus of buses) bus.close();
    }
  });

  it("shares the line's hash with the other tabs, never its body, and ignores a shape it does not know", async () => {
    const name = `grappa-e2e-sent-test-${Math.random()}`;
    const [sender, listener, stranger] = [0, 1, 2].map(() => new BroadcastChannel(name)) as [
      BroadcastChannel,
      BroadcastChannel,
      BroadcastChannel,
    ];
    try {
      const posted: unknown[] = [];
      listener.addEventListener("message", (e) => posted.push(e.data));
      const log = new SendLog(sender);
      await log.record(LINE);
      await expect.poll(() => posted.length, { timeout: 1_000 }).toBe(1);
      expect(JSON.stringify(posted[0])).not.toContain(LINE.body);
      expect(posted[0]).toEqual({
        op: "record",
        line: expect.objectContaining({ sha256: sha256(LINE.body), nonce: null }),
      });

      const fresh = new SendLog(listener);
      stranger.postMessage({ op: "record", line: { ...LINE } });
      stranger.postMessage({ op: "erase", line: posted[0] });
      stranger.postMessage({
        op: "record",
        line: { ...LINE, body: undefined, sha256: sha256(LINE.body), nonce: null },
      });
      await expect
        .poll(() => fresh.confirms(chalFor(LINE), BOT, SCOPE, AT), { timeout: 1_000 })
        .toBe("confirmed");
      // The body-carrying shape and the unknown op were dropped: one line, one confirmation.
      expect(fresh.confirms(chalFor(LINE, { nonce: "YWdhaW4" }), BOT, SCOPE, AT)).toBe("not-sent");
    } finally {
      for (const bus of [sender, listener, stranger]) bus.close();
    }
  });
});

describe("parseChallenge", () => {
  const inner = {
    t: "chal",
    network: "AzzurraNet",
    channel: "#grappa",
    sender_mask: "vjt!~vjt@azzurra.example",
    line_sha256: sha256("i2430-bot: ping"),
    nonce: "bm9uY2Uwbm9uY2Uw",
    expires_at: 1_700_000_015,
  };

  it("reads the bot's inner CHAL (irc-olm challenge.py)", () => {
    expect(parseChallenge(inner)).toEqual({
      network: "AzzurraNet",
      channel: "#grappa",
      senderMask: "vjt!~vjt@azzurra.example",
      lineSha256: inner.line_sha256,
      nonce: "bm9uY2Uwbm9uY2Uw",
      expiresAt: 1_700_000_015,
    });
  });

  it("refuses a CHAL with a field missing or malformed", () => {
    const bad: Record<string, unknown>[] = [
      { ...inner, t: "ack" },
      { ...inner, network: 7 },
      { ...inner, channel: undefined },
      { ...inner, sender_mask: null },
      { ...inner, nonce: "" },
      { ...inner, line_sha256: inner.line_sha256.toUpperCase() },
      { ...inner, line_sha256: inner.line_sha256.slice(1) },
      { ...inner, expires_at: 1_700_000_015.5 },
      { ...inner, expires_at: "1700000015" },
    ];
    for (const b of bad) expect(parseChallenge(b), JSON.stringify(b)).toBeNull();
  });
});
