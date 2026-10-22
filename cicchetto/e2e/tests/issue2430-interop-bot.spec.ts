// issue 2430 interop — cicchetto and the irc-olm bot in one encrypted query,
// end to end: a real browser running cicchetto's vodozemac engine, grappa,
// one real bahamut, and claude-ircbot's bot.py on irc-olm (the e2e-bot
// service, fixtures/e2eBot.ts) — the code the real bots run.
//
// The two engines were written apart, in two languages, from one spec. Each
// side's own tests prove it agrees with itself; only this one proves the two
// agree with each other:
//   1. the cic user's nick is registered with NickServ, because the bot's
//      trust layer 1 needs a 307 in its WHOIS, and the bot comes up trusting
//      it;
//   2. each side pins the other's key by hand: cic pastes the bot's key in
//      the pane, the bot's operator writes cic's into its pins file;
//   3. cic → bot, first contact: KEYREQ, KEYS, a pre-key message, and the
//      bot shows the text as a TRUSTED encrypted message;
//   4. bot → cic on the session that opened, shown in the query;
//   5. a message longer than one IRC line, both ways: fragmented by one
//      engine, reassembled by the other, paced by the bot without the ircd
//      dropping it;
//   6. an order in a channel, typed in cic's compose box: the bot holds it,
//      challenges it inside the session, cic ACKs because it sent that line,
//      and the bot takes it as CONFIRMED;
//   7. an order sent as the same nick through grappa's REST door, which is
//      what any other client of the user looks like to cic: the bot
//      challenges it the same way, cic never sent it and stays silent, and
//      the bot refuses it once the challenge expires.
//
// ## What makes this spec able to fail
//
//   * The two engines disagree on the framing, the inner message, the key
//     encoding or the Olm session: the text never shows on the other side,
//     or shows as undecryptable, or the bot raises the key alarm.
//   * A pin is not applied: cic's badge does not read verified, or the bot
//     drops the message as from a key it did not pin.
//   * Reassembly or pacing breaks: the long message never shows, or the bot
//     is disconnected by the ircd.
//   * The two sides name the order differently (the network, the channel, the
//     line's hash) or cic does not answer: the order cic sent comes out
//     UNTRUSTED no-ack. cic confirms a line it did not send: the REST one
//     comes out CONFIRMED.
//
// Timeouts are the 2430 bounds, never sleeps: KEYS within 32 s of a KEYREQ,
// a message under way within 46 s, an order challenge answered within 15 s.

import { composeSend, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { botCmd, botEvents, botPins, botWaitFor, test } from "../fixtures/e2eBot";
import { boot, e2eWindow, equery, ownKey, pin, row, send } from "../fixtures/encryptedQuery";
import { joinChannel, sendPrivmsg } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { awaitMail, extractFromMail } from "../fixtures/mailpit";
import { NETWORK_SLUG } from "../fixtures/seedData";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect } from "../fixtures/test";

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The 2430 bounds: a KEYREQ answered within 32 s, a message under way
// delivered within 46 s.
const KEYS_BOUND = 32_000;
const UNDER_WAY_BOUND = 46_000;
// An order challenge lives 15 s (irc-olm CHALLENGE_TTL); the bot ends a held
// line at its next tick past that, so its verdict is in well within 25 s.
const ORDER_VERDICT = 25_000;

// Azzurra's NickServ: 5–32 chars, and the confirmation mail carries the code
// as `/msg NickServ AUTH <digits>` (registration-wizard-real.spec.ts).
const NS_PASSWORD = "e2eintpw1";
const AUTH_CODE_RE = /AUTH (\d+)/;
// One WHOIS round trip: it sits behind bahamut's fake-lag bank, ~10 s cap.
const WHOIS_ASK = 15_000;

// Registration, a bot start, the browser boot, then six exchanges each
// bounded by the figures above.
test.setTimeout(480_000);

// Whether `nick` is registered as the bot will see it: a WHOIS whose replies
// carry a 307 before their 318. Asked again until one does — services set
// +r over the server link a moment after they accept the code.
async function awaitRegistered(peer: IrcPeer, nick: string, timeoutMs: number): Promise<void> {
  const about = (numeric: string) => new RegExp(`^:\\S+ ${numeric} \\S+ ${escapeRe(nick)} `, "i");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let registered = false;
    peer.waitForLine(about("307"), "307", WHOIS_ASK).then(
      () => {
        registered = true;
      },
      () => {},
    );
    const end = peer.waitForLine(about("318"), `the end of WHOIS ${nick}`, WHOIS_ASK);
    peer.whois(nick);
    await end;
    if (registered) return;
  }
  throw new Error(`${nick} is not registered with NickServ after ${timeoutMs}ms`);
}

// A body no single IRC line can carry (1 KiB and more against a 512-byte
// line): each side has to cut it into fragments and the other has to put them
// back together.
const longBody = (from: string): string =>
  `${from}: ${Array.from({ length: 60 }, (_, i) => `parola${i} è cifrata`).join(" ")} fine`;

// The bot's verdict on the order `body` from `nick`: either way, so a wrong
// one fails at once and names itself instead of running out the clock.
const orderVerdict = (nick: string, body: string): RegExp =>
  new RegExp(
    ` MSG (TRUSTED CONFIRMED=1|UNTRUSTED WHY=\\S+) FROM=${escapeRe(nick)} .* BODY=${escapeRe(body)}$`,
  );

test("cicchetto and the irc-olm bot talk in an encrypted query: pinned by hand both ways, both directions, long messages, an order confirmed and one refused", async ({
  page,
  e2eBot,
}, testInfo) => {
  const run = Date.now().toString(36);
  // A subject of its own, named per run: its nick gets registered with
  // NickServ, which keeps a nick registered for as long as the testnet lives.
  const cic = await provisionPeerSubject(testInfo, `cic-${run}`);
  try {
    // 1. Register the cic user's nick through grappa, the way a client would,
    //    and wait until a WHOIS says so.
    const email = `${cic.nick}-${run}@example.com`;
    await sendPrivmsg(cic.user.token, NETWORK_SLUG, "NickServ", `REGISTER ${NS_PASSWORD} ${email}`);
    const code = extractFromMail(await awaitMail(email, { timeoutMs: 45_000 }), AUTH_CODE_RE);
    await sendPrivmsg(cic.user.token, NETWORK_SLUG, "NickServ", `AUTH ${code}`);
    const witness = await IrcPeer.connect({ nick: `iw${run}` });
    try {
      await awaitRegistered(witness, cic.nick, 30_000);
    } finally {
      await witness.disconnect("done");
    }

    // The bot comes up trusting the cic nick from any host, and asks its
    // WHOIS on connect: VERIFIED is layer 1 satisfied.
    const bot = await e2eBot.start({ nick: `ib${run}`, trust: [`${cic.nick} *`], dmallow: [] });
    await botWaitFor(
      new RegExp(` VERIFIED ${escapeRe(cic.nick)}$`, "i"),
      bot.since,
      WHOIS_ASK,
      "VERIFIED",
    );

    // 2. Pins, both ways, by hand.
    await boot(page, cic.user);
    await equery(page, cic.nick, bot.nick);
    await pin(page, bot.ed25519);
    await botPins({ [cic.nick]: await ownKey(page) });

    // 3. cic → bot, first contact.
    const hello = "hello bot";
    await send(page, hello);
    await expect(row(page, "out", hello).getByTestId("e2e-row-state")).toHaveAttribute(
      "data-state",
      "sent",
      { timeout: KEYS_BOUND },
    );
    await botWaitFor(
      new RegExp(` MSG TRUSTED ENCRYPTED=1 FROM=${escapeRe(cic.nick)} .* BODY=${escapeRe(hello)}$`),
      bot.since,
      UNDER_WAY_BOUND,
      "cic's first message",
    );

    // 4. bot → cic.
    const reply = "hello cic";
    await botCmd(`ESAY ${cic.nick} ${reply}`);
    await expect(row(page, "in", reply)).toHaveCount(1, { timeout: UNDER_WAY_BOUND });

    // 5. Longer than a line, both ways.
    const longOut = longBody("cic");
    expect(new TextEncoder().encode(longOut).length).toBeGreaterThan(1024);
    await send(page, longOut);
    await botWaitFor(
      new RegExp(
        ` MSG TRUSTED ENCRYPTED=1 FROM=${escapeRe(cic.nick)} .* BODY=${escapeRe(longOut)}$`,
      ),
      bot.since,
      UNDER_WAY_BOUND,
      "cic's long message",
    );
    const longIn = longBody("bot");
    await botCmd(`ESAY ${cic.nick} ${longIn}`);
    await expect(row(page, "in", longIn)).toHaveCount(1, { timeout: UNDER_WAY_BOUND });

    // Both in one channel. The bot has to be there before an order is said,
    // or it never hears it.
    const chan = `#e2e-interop-${run}`;
    await botCmd(`JOIN ${chan}`);
    const joined = await botWaitFor(
      new RegExp(` JOIN ${escapeRe(bot.nick)} .* ${escapeRe(chan)}$`, "i"),
      bot.since,
      UNDER_WAY_BOUND,
      "the bot's JOIN",
    );
    await joinChannel(cic.user.token, NETWORK_SLUG, chan);
    await selectChannel(page, NETWORK_SLUG, chan, { ownNick: cic.nick });

    // 6. An order cic sent: challenged, ACKed, confirmed.
    const order = `${bot.nick}: ping`;
    await composeSend(page, order);
    await botWaitFor(
      new RegExp(` ORDER_HELD FROM=${escapeRe(cic.nick)} .* TO=${escapeRe(chan)} `, "i"),
      joined.n + 1,
      UNDER_WAY_BOUND,
      "the order held",
    );
    const confirmed = await botWaitFor(
      orderVerdict(cic.nick, order),
      joined.n + 1,
      ORDER_VERDICT,
      "the verdict on the order cic sent",
    );
    expect(confirmed.line).toMatch(/ MSG TRUSTED CONFIRMED=1 /);

    // 7. An order in cic's nick that cic did not send: another client of
    //    the same user, as far as cic can tell. Challenged the same way,
    //    never ACKed, refused when the challenge expires.
    const forged = `${bot.nick}: not from cic`;
    await sendPrivmsg(cic.user.token, NETWORK_SLUG, chan, forged);
    await botWaitFor(
      new RegExp(` ORDER_HELD FROM=${escapeRe(cic.nick)} .* TO=${escapeRe(chan)} `, "i"),
      confirmed.n + 1,
      UNDER_WAY_BOUND,
      "the REST order held",
    );
    const refused = await botWaitFor(
      orderVerdict(cic.nick, forged),
      confirmed.n + 1,
      ORDER_VERDICT,
      "the verdict on the REST order",
    );
    expect(refused.line).toMatch(/ MSG UNTRUSTED WHY=no-ack /);

    // Nothing went wrong on the bot's side along the way, and the window the
    // absences are read over holds the whole exchange.
    const lines = (await botEvents(bot.since)).map((e) => e.line);
    expect(lines.filter((l) => / E2E_PINS_LOADED N=1$/.test(l))).toHaveLength(1);
    // One verdict per order: no late ACK turned the refused one around.
    expect(lines.filter((l) => orderVerdict(cic.nick, forged).test(l))).toHaveLength(1);
    expect(
      lines.filter((l) =>
        / (E2E_KEY_ALARM|E2E_UNDECRYPTABLE|E2E_SEND_FAILED|E2E_DROPPED|E2E_PINS_WRITABLE|ORDER_ACK_REJECTED|DISCONNECTED|FATAL)( |$)/.test(
          l,
        ),
      ),
    ).toEqual([]);
    // Back in the query: the absences below are read off its pane.
    await sidebarWindow(page, NETWORK_SLUG, e2eWindow(bot.nick)).locator("button").first().click();
    await expect(page.getByTestId("e2e-pane")).toBeVisible();
    await expect(row(page, "in", longIn)).toHaveCount(1);
    await expect(
      page.locator('[data-testid="e2e-row"][data-row-kind="undecryptable"]'),
    ).toHaveCount(0);
    await expect(page.getByTestId("e2e-peer-trust")).toHaveAttribute("data-trust", "verified");
  } finally {
    await teardownSpecSubject(cic);
  }
});
