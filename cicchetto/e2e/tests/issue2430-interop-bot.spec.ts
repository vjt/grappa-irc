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
//   2. the bot's operator pins cic's master key first: the bot answers no
//      KEYREQ from a nick it has no pin for (E2E_DROPPED REASON=unpinned-nick).
//      cic pins nothing by hand (issue 2544 took the pasted pin away);
//   3. cic → bot, first contact: KEYREQ, KEYS naming the bot's one device
//      under its master, a pre-key message, and the bot shows the text as a
//      TRUSTED encrypted message. cic took the bot's master on first use, not
//      verified; the user compares it with the key the bot prints and
//      verifies it by hand, which sends a listreq (O1);
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
// issue 2485 — neither answer (6's ACK, 7's silence) shows as a row in any
// window: no plaintext query with the bot opens, the encrypted chat gains no
// row and no unread. What the user sees instead is the last identity check,
// a ✓ then a ✗ in the encrypted window's top bar, and where, when and why in
// the rail.
//
// ## What makes this spec able to fail
//
//   * The two engines disagree on the framing, the inner message, the key
//     encoding or the Olm session: the text never shows on the other side,
//     or shows as undecryptable, or the bot raises the key alarm.
//   * cic does not take the bot's key on first use, or takes another, or the
//     verify is not applied: the rail does not show the key the bot prints,
//     the badge does not read verified, or the bot drops the message as from
//     a key it did not pin.
//   * The bot's KEYS do not name its device under its master in a shape
//     cic reads: the pane does not count one device for it.
//   * Reassembly or pacing breaks: the long message never shows, or the bot
//     is disconnected by the ircd.
//   * The two sides name the order differently (the network, the channel, the
//     line's hash) or cic does not answer: the order cic sent comes out
//     UNTRUSTED no-ack. cic confirms a line it did not send: the REST one
//     comes out CONFIRMED.
//   * A challenge leaves a trace in a window (a query with the bot, a row or
//     an unread in the encrypted chat), or the identity check does not follow
//     it: the chip and the rail do not read passed, then failed for not-sent.
//
// Timeouts are the 2430 bounds, never sleeps: KEYS within 32 s of a KEYREQ,
// a message under way within 46 s, an order challenge answered within 15 s.

import {
  composeSend,
  selectChannel,
  sidebarMessageBadge,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import {
  botCmd,
  botEvents,
  botPins,
  test as botTest,
  botWaitFor,
  escapeRe,
  KEYS_BOUND,
  ORDER_VERDICT,
  orderVerdict,
  PINS_RELOAD,
  registerNick,
  UNDER_WAY_BOUND,
  WHOIS_ASK,
} from "../fixtures/e2eBot";
import {
  boot,
  chatLines,
  e2eWindow,
  equery,
  ownKey,
  row,
  send,
  trust,
  verify,
} from "../fixtures/encryptedQuery";
import { joinChannel, sendPrivmsg } from "../fixtures/grappaApi";
import { NETWORK_SLUG } from "../fixtures/seedData";
import { expect } from "../fixtures/test";

// The waits below, each at its bound, add up to about ten minutes (mail 45 s,
// registration 30 s, the bot's start 45 s, VERIFIED 15 s, the pin's load
// 15 s, then the six exchanges); they never all run to their bound, but the
// budget must not cut one short.
const BUDGET = 720_000;

// The cic subject comes from the bot fixture (fixtures/e2eBot.ts), torn down
// by it. A red run gets cic's `[e2e]` console lines attached: what it decided
// about each challenge.
const test = botTest.extend<{ e2eConsole: string[] }>({
  e2eConsole: [
    async ({ page }, use, testInfo) => {
      const lines: string[] = [];
      page.on("console", (m) => {
        if (m.text().startsWith("[e2e]")) lines.push(m.text());
      });
      await use(lines);
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach("cic [e2e] console", {
          body: lines.join("\n"),
          contentType: "text/plain",
        });
      }
    },
    { auto: true },
  ],
});

test.setTimeout(BUDGET);

// A body no single IRC line can carry (1 KiB and more against a 512-byte
// line): each side has to cut it into fragments and the other has to put them
// back together.
const longBody = (from: string): string =>
  `${from}: ${Array.from({ length: 60 }, (_, i) => `parola${i} è cifrata`).join(" ")} fine`;

test("cicchetto and the irc-olm bot talk in an encrypted query: cic's key pinned in the bot, the bot's verified by hand, both directions, long messages, an order confirmed and one refused", async ({
  page,
  e2eBot,
  cic,
}) => {
  const run = Date.now().toString(36);
  // 1. Register the cic user's nick through grappa, the way a client would,
  //    and wait until a WHOIS says so.
  await registerNick(cic, run);

  // The bot comes up trusting the cic nick from any host, and asks its
  // WHOIS on connect: VERIFIED is layer 1 satisfied.
  const bot = await e2eBot.start({ nick: `ib${run}`, trust: [`${cic.nick} *`], dmallow: [] });
  await botWaitFor(
    new RegExp(` VERIFIED ${escapeRe(cic.nick)}$`, "i"),
    bot.since,
    WHOIS_ASK,
    "VERIFIED",
  );

  // 2. cic's key pinned in the bot, loaded before cic writes (its ticker
  //    reloads the file once a second).
  await boot(page, cic.user);
  await equery(page, cic.nick, bot.nick);
  await botPins({ [cic.nick]: await ownKey(page) });
  await botWaitFor(/ E2E_PINS_LOADED N=1$/, bot.since, PINS_RELOAD, "cic's pin loaded");

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
  // The keys cic took from the Python engine named the bot's one device.
  await expect(page.getByTestId("e2e-peer-devices")).toHaveText("1 device");
  // Taken on first use, not verified; the key is the one the bot prints, and
  // the user verifies it by hand. Before any order: cic answers no challenge
  // from a key it has not verified.
  await expect(trust(page)).toHaveAttribute("data-trust", "unverified");
  await verify(page, bot.ed25519);

  // 4. bot → cic.
  const reply = "hello cic";
  await botCmd(`ESAY ${cic.nick} ${reply}`);
  await expect(row(page, "in", reply)).toHaveCount(1, { timeout: UNDER_WAY_BOUND });

  // 5. Longer than a line, both ways.
  const longOut = longBody("cic");
  expect(new TextEncoder().encode(longOut).length).toBeGreaterThan(1024);
  await send(page, longOut);
  await botWaitFor(
    new RegExp(` MSG TRUSTED ENCRYPTED=1 FROM=${escapeRe(cic.nick)} .* BODY=${escapeRe(longOut)}$`),
    bot.since,
    UNDER_WAY_BOUND,
    "cic's long message",
  );
  const longIn = longBody("bot");
  await botCmd(`ESAY ${cic.nick} ${longIn}`);
  await expect(row(page, "in", longIn)).toHaveCount(1, { timeout: UNDER_WAY_BOUND });

  // What the encrypted chat shows before any challenge: the four messages.
  const messages = chatLines(page);
  await expect(messages).toHaveCount(4);
  await expect(page.getByTestId("e2e-check-chip")).toHaveCount(0);

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

  // The ACK wrote nothing anywhere: no query with the bot, no unread on the
  // encrypted chat, the same four messages in it. The check says it passed.
  const encrypted = sidebarWindow(page, NETWORK_SLUG, e2eWindow(bot.nick));
  await expect(sidebarWindow(page, NETWORK_SLUG, bot.nick)).toHaveCount(0);
  await expect(sidebarMessageBadge(page, NETWORK_SLUG, e2eWindow(bot.nick))).toHaveCount(0);
  await encrypted.locator("button").first().click();
  await expect(page.getByTestId("e2e-pane")).toBeVisible();
  const chip = page.getByTestId("e2e-pane").locator("header").getByTestId("e2e-check-chip");
  const check = page.getByTestId("e2e-rail").getByTestId("e2e-identity-check");
  await expect(chip).toHaveAttribute("data-passed", "true");
  await expect(check).toHaveAttribute("data-passed", "true");
  await expect(check).toContainText(`${chan} on `);
  await expect(messages).toHaveCount(4);

  // 7. An order in cic's nick that cic did not send: another client of
  //    the same user, as far as cic can tell. Challenged the same way,
  //    never ACKed, refused when the challenge expires. Read from the
  //    channel, as step 6 was: a focused encrypted pane marks what lands in
  //    it read at once, and "no unread" would then prove nothing.
  await selectChannel(page, NETWORK_SLUG, chan, { ownNick: cic.nick });
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

  // cic's silence wrote nothing either; the check says why it went
  // unanswered: not by this device, which is no red alarm (a sibling device's
  // orders read the same here, DESIGN_NOTES #2485).
  await expect(sidebarWindow(page, NETWORK_SLUG, bot.nick)).toHaveCount(0);
  await expect(sidebarMessageBadge(page, NETWORK_SLUG, e2eWindow(bot.nick))).toHaveCount(0);
  await encrypted.locator("button").first().click();
  await expect(page.getByTestId("e2e-pane")).toBeVisible();
  await expect(chip).toHaveAttribute("data-passed", "false");
  await expect(chip).toHaveClass(/\be2e-check-unanswered\b/);
  await expect(check).toHaveAttribute("data-reason", "not-sent");
  await expect(check).toContainText(`${chan} on `);
  await expect(messages).toHaveCount(4);

  // Nothing went wrong on the bot's side along the way, and the window the
  // absences are read over holds the whole exchange.
  const lines = (await botEvents(bot.since)).map((e) => e.line);
  expect(lines.filter((l) => / E2E_PINS_LOADED N=1$/.test(l))).toHaveLength(1);
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
  await expect(page.getByTestId("e2e-pane").getByTestId("e2e-undeliverable")).toHaveCount(0);
  await expect(trust(page)).toHaveAttribute("data-trust", "verified");
  // issue 2544 — the verified badge shows the bot's key, whole, and offers no
  // emoji comparison: the bot would never answer one.
  await trust(page).click();
  const keyDialog = page.getByTestId("e2e-key-dialog");
  await expect(keyDialog.getByTestId("e2e-key-dialog-key")).toHaveText(bot.ed25519);
  await expect(keyDialog.getByTestId("e2e-key-compare")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /compare emoji/ })).toHaveCount(0);
});
