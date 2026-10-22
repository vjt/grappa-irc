// issue 2430 "Authorising orders" — the send log an order challenge is
// checked against: cicchetto ACKs a CHAL only for a line THIS cic sent, on
// that network, in that channel, in the last 15 s.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type Challenge,
  type OrderScope,
  parseChallenge,
  SENT_WINDOW_MS,
  SendLog,
  type SentLine,
} from "../lib/e2e/orders";

const AT = 1_700_000_000_000;
const SCOPE: OrderScope = { slug: "azzurra", network: "AzzurraNet", casemapping: "ascii" };
const LINE: SentLine = { slug: "azzurra", target: "#grappa", body: "i2430-bot: ping", at: AT };

// The bot's hash, by an implementation that is not the one under test.
const sha256 = (body: string): string => createHash("sha256").update(body, "utf8").digest("hex");

const chalFor = (line: SentLine, over: Partial<Challenge> = {}): Challenge => ({
  network: "AzzurraNet",
  channel: line.target,
  senderMask: "vjt!~vjt@azzurra.example",
  lineSha256: sha256(line.body),
  nonce: "bm9uY2Uwbm9uY2Uw",
  expiresAt: Math.floor(AT / 1000) + 15,
  ...over,
});

const logWith = (...lines: SentLine[]): SendLog => {
  const log = new SendLog(null);
  for (const line of lines) log.record(line);
  return log;
};

describe("SendLog.confirms", () => {
  it("confirms a line this cic sent there, inside the window", async () => {
    const log = logWith(LINE);
    expect(await log.confirms(chalFor(LINE), SCOPE, AT + 2_000)).toBe(true);
    // The window's own edge, under a challenge that lives past it.
    const later = chalFor(LINE, { expiresAt: Math.floor(AT / 1000) + 30 });
    expect(await log.confirms(later, SCOPE, AT + SENT_WINDOW_MS)).toBe(true);
  });

  it("matches the channel as the network folds it, and a plaintext PM by the bot's nick", async () => {
    const pm: SentLine = { ...LINE, target: "i2430-Bot", body: "status" };
    const log = logWith(LINE, pm);
    expect(await log.confirms(chalFor(LINE, { channel: "#GRAPPA" }), SCOPE, AT)).toBe(true);
    expect(await log.confirms(chalFor(pm, { channel: "I2430-bot" }), SCOPE, AT)).toBe(true);
  });

  it("hashes the body as UTF-8 bytes", async () => {
    const line: SentLine = { ...LINE, body: "i2430-bot: è così 🔐" };
    expect(await logWith(line).confirms(chalFor(line), SCOPE, AT)).toBe(true);
  });

  it("stays silent for anything this cic did not send just there, just then", async () => {
    const log = logWith(LINE);
    const refused: [string, Challenge, OrderScope, number][] = [
      ["another line", chalFor({ ...LINE, body: "i2430-bot: pong" }), SCOPE, AT],
      ["another channel", chalFor(LINE, { channel: "#grappa2" }), SCOPE, AT],
      ["another network's slug", chalFor(LINE), { ...SCOPE, slug: "libera" }, AT],
      ["another network's name", chalFor(LINE, { network: "Libera.Chat" }), SCOPE, AT],
      ["a name differing in case", chalFor(LINE, { network: "azzurranet" }), SCOPE, AT],
      ["a network with no name", chalFor(LINE), { ...SCOPE, network: null }, AT],
      [
        "a line older than the window",
        chalFor(LINE, { expiresAt: Math.floor(AT / 1000) + 30 }),
        SCOPE,
        AT + SENT_WINDOW_MS + 1,
      ],
      ["a challenge already expired", chalFor(LINE, { expiresAt: AT / 1000 }), SCOPE, AT],
    ];
    for (const [what, chal, scope, at] of refused) {
      expect(await log.confirms(chal, scope, at), what).toBe(false);
    }
  });

  it("a forgotten line confirms nothing (its send failed)", async () => {
    const log = logWith(LINE);
    log.forget(LINE);
    expect(await log.confirms(chalFor(LINE), SCOPE, AT)).toBe(false);
  });

  it("another tab's send counts: the log is the device's, not the tab's", async () => {
    const name = `grappa-e2e-sent-test-${Math.random()}`;
    const here = new SendLog(new BroadcastChannel(name));
    const there = new SendLog(new BroadcastChannel(name));
    here.record(LINE);
    await expect
      .poll(() => there.confirms(chalFor(LINE), SCOPE, AT), { timeout: 1_000 })
      .toBe(true);
    here.forget(LINE);
    await expect
      .poll(() => there.confirms(chalFor(LINE), SCOPE, AT), { timeout: 1_000 })
      .toBe(false);
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
