// #2430 interop, the harness — the e2e-bot service on the live testnet.
//
// The interop specs (cicchetto ↔ bot) stand on this service: claude-ircbot's
// bot.py on the irc-olm engine, the code the real bots run, started and
// driven over HTTP (fixtures/e2eBot.ts, e2e-bot/control.py). Before any of
// them can mean anything, the harness has to do what it claims on a real
// bahamut:
//   * it registers and comes up E2E-ready, with a master key to pin (wire
//     v2: it vouches for the bot's devices);
//   * its FIFO drives it, and what it does is SERVED by the ircd: a peer sees
//     the JOIN it was told to make;
//   * a stranger's private message never reaches its stream: DM_BLOCKED, no
//     BODY, and the stranger gets the bot's NOTICE;
//   * it reloads its pins when they change (what the manual pin rides on),
//     and finds them unwritable — root-owned, its README's posture — so
//     E2E_PINS_WRITABLE never appears.
// The cicchetto side (pins both ways, encrypted messages, the order
// challenge) is issue2430-interop-bot.spec.ts.

import { generateKeyPairSync } from "node:crypto";
import { botCmd, botEvents, botPins, botWaitFor, test } from "../fixtures/e2eBot";
import { IrcPeer } from "../fixtures/ircClient";
import { expect } from "../fixtures/test";

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A master key that is nobody's: the peer is a plain IRC client and has none.
const strangerKey = (): string =>
  Buffer.from(
    generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x as string,
    "base64url",
  )
    .toString("base64")
    .replace(/=+$/, "");

// botStart may take START_TIMEOUT (45 s) to answer 504; three 15 s waits follow.
test.setTimeout(120_000);

test("#2430 — the e2e-bot runs claude-ircbot on the testnet: E2E-ready, driven by its FIFO, a stranger's DM blocked, pins read-only", async ({
  e2eBot,
}) => {
  const run = Date.now().toString(36);
  const bot = await e2eBot.start({ nick: `ib${run}`, trust: [], dmallow: [] });
  expect(bot.ed25519).toMatch(/^[A-Za-z0-9+/]{43}$/);
  const peer = await IrcPeer.connect({ nick: `ip${run}` });
  try {
    const channel = `#t2430b-${run}`;
    await peer.join(channel);
    const joined = peer.waitForLine(
      new RegExp(`^:${escapeRe(bot.nick)}!\\S+ JOIN :?${escapeRe(channel)}$`, "i"),
      "the bot's JOIN",
      15_000,
    );
    joined.catch(() => {});
    await botCmd(`JOIN ${channel}`);
    await joined;

    const notice = peer.waitForLine(
      new RegExp(`^:${escapeRe(bot.nick)}!\\S+ NOTICE ${escapeRe(peer.nick)} :`, "i"),
      "the bot's NOTICE",
      15_000,
    );
    notice.catch(() => {});
    peer.privmsg(bot.nick, "ciao bot");
    await botWaitFor(
      new RegExp(` DM_BLOCKED FROM=${escapeRe(peer.nick)} `),
      bot.since,
      15_000,
      "DM_BLOCKED",
    );
    await notice;

    await botPins({ [peer.nick]: strangerKey() });
  } finally {
    await peer.disconnect("done");
  }
  const lines = (await botEvents(bot.since)).map((e) => e.line);
  // The window holds both loads, or the absences below would prove nothing.
  expect(lines.some((l) => / E2E_PINS_LOADED N=0$/.test(l))).toBe(true);
  expect(lines.some((l) => / E2E_PINS_LOADED N=1$/.test(l))).toBe(true);
  expect(lines.filter((l) => / E2E_PINS_WRITABLE /.test(l))).toEqual([]);
  expect(lines.filter((l) => l.includes("ciao bot"))).toEqual([]);
});
