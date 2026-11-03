// #2430 interop — the e2e-bot service's control API (e2e-bot/control.py).
//
// e2e-bot runs claude-ircbot's bot.py on the irc-olm engine: the BOT side of
// the E2E query protocol, the code the real bots run, fetched at pinned
// commits. A spec starts it fresh (a new nick and a new identity key:
// /data/bot is wiped on every start), drives it through its FIFO verbs, and
// reads what it says on stdout — the bot's own event lines (`[HH:MM] KIND …`,
// claude-ircbot README). Waits match events; nothing here sleeps.
//
// The service idles until a spec starts it. Specs take the `e2eBot` fixture
// below: its teardown stops the bot, and Playwright runs a fixture teardown on
// a test timeout too — a `finally` in the test body it does not (measured on
// 1.59.1). A bot left running is an extra client every later spec meets.

import { sendPrivmsg } from "./grappaApi";
import { IrcPeer } from "./ircClient";
import { awaitMail, extractFromMail } from "./mailpit";
import { NETWORK_SLUG } from "./seedData";
import { provisionPeerSubject, type SpecSubject, teardownSpecSubject } from "./specSubject";
import { test as base, expect } from "./test";

const E2E_BOT_URL = process.env.E2E_BOT_URL ?? "http://e2e-bot:8080";

/** One line of the bot's stdout; `n` is its index across every run. */
export type BotEvent = { n: number; t: number; line: string };

/** What `botStart` answers: the bot's nick, its Ed25519 identity key (what a
 *  peer pins), and the index its events start at. */
export type StartedBot = { nick: string; ed25519: string; since: number };

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${E2E_BOT_URL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  expect(res.status, `e2e-bot ${method} ${path}: ${text}`).toBe(200);
  return JSON.parse(text) as unknown;
}

/**
 * Starts a fresh bot as `nick`. `trust` and `dmallow` are bot.trust and
 * bot.dmallow lines (`<nick> <host_glob>`). There are no pins until
 * `botPins`. Resolves once the bot is E2E-ready, registered and reading its
 * FIFO.
 */
async function botStart(opts: {
  nick: string;
  trust: string[];
  dmallow: string[];
}): Promise<StartedBot> {
  return (await call("POST", "/start", opts)) as StartedBot;
}

async function botStop(): Promise<void> {
  await call("POST", "/stop", {});
}

/** Rewrites the bot's pins (`{nick: ed25519}`), root-owned like an
 *  operator's. Resolves once the bot reloaded them. */
export async function botPins(pins: Record<string, string>): Promise<void> {
  await call("PUT", "/pins", { pins });
}

/** One line into the bot's FIFO: any bot verb (SAY, ESAY, JOIN, …). */
export async function botCmd(line: string): Promise<void> {
  await call("POST", "/cmd", { line });
}

/** Every event from `since` on, as of now. */
export async function botEvents(since: number): Promise<BotEvent[]> {
  const doc = (await call("GET", `/events?since=${since}&wait=0`)) as { events: BotEvent[] };
  return doc.events;
}

/** The first event from `since` on that matches `pattern`, long-polling
 *  until `timeoutMs`; fails naming `label` and the last lines seen. */
export async function botWaitFor(
  pattern: RegExp,
  since: number,
  timeoutMs: number,
  label: string,
): Promise<BotEvent> {
  const deadline = Date.now() + timeoutMs;
  let next = since;
  const seen: BotEvent[] = [];
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) {
      const tail = seen.slice(-15).map((e) => e.line);
      throw new Error(`e2e-bot: no ${label} in ${timeoutMs}ms; last lines:\n${tail.join("\n")}`);
    }
    const wait = Math.min(30, Math.ceil(left / 1000));
    const doc = (await call("GET", `/events?since=${next}&wait=${wait}`)) as {
      next: number;
      events: BotEvent[];
    };
    for (const ev of doc.events) {
      seen.push(ev);
      if (pattern.test(ev.line)) return ev;
    }
    next = doc.next;
  }
}

export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The 2430 bounds: a KEYREQ answered within 32 s, a message under way
// delivered within 46 s.
export const KEYS_BOUND = 32_000;
export const UNDER_WAY_BOUND = 46_000;
// An order challenge lives 15 s (irc-olm CHALLENGE_TTL); the bot ends a held
// line at its next tick past that, so its verdict is in well within 25 s.
export const ORDER_VERDICT = 25_000;
// The bot reloads its pins file at a 1 s tick.
export const PINS_RELOAD = 15_000;
// One WHOIS round trip: it sits behind bahamut's fake-lag bank, ~10 s cap.
export const WHOIS_ASK = 15_000;

// Azzurra's NickServ: 5–32 chars, and the confirmation mail carries the code
// as `/msg NickServ AUTH <digits>` (registration-wizard-real.spec.ts).
const NS_PASSWORD = "e2eintpw1";
const AUTH_CODE_RE = /AUTH (\d+)/;

// Whether `nick` is registered as the bot will see it: a WHOIS whose replies
// carry a 307. Asked again until one does, half a second apart — services
// set +r over the server link a moment after they accept the code. A 401
// (the nick is not on the network) rejects at once.
async function awaitRegistered(peer: IrcPeer, nick: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await peer.whoisRegistered(nick)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${nick} is not registered with NickServ after ${timeoutMs}ms`);
}

/**
 * Registers the subject's nick with NickServ through grappa, the way a
 * client would, and resolves once a WHOIS says so: the bot's trust layer 1
 * needs that 307. `run` names the mail and the witness, per run, because
 * NickServ keeps a nick registered for as long as the testnet lives.
 */
export async function registerNick(subject: SpecSubject, run: string): Promise<void> {
  const email = `${subject.nick}-${run}@example.com`;
  await sendPrivmsg(
    subject.user.token,
    NETWORK_SLUG,
    "NickServ",
    `REGISTER ${NS_PASSWORD} ${email}`,
  );
  const code = extractFromMail(await awaitMail(email, { timeoutMs: 45_000 }), AUTH_CODE_RE);
  await sendPrivmsg(subject.user.token, NETWORK_SLUG, "NickServ", `AUTH ${code}`);
  const witness = await IrcPeer.connect({ nick: `iw${run}` });
  try {
    await awaitRegistered(witness, subject.nick, 30_000);
  } finally {
    await witness.disconnect("done");
  }
}

// The bot's verdict on the order `body` from `nick`: either way, so a wrong
// one fails at once and names itself instead of running out the clock.
export const orderVerdict = (nick: string, body: string): RegExp =>
  new RegExp(
    ` MSG (TRUSTED CONFIRMED=1|UNTRUSTED WHY=\\S+) FROM=${escapeRe(nick)} .* BODY=${escapeRe(body)}$`,
  );

/**
 * The bot, stopped in teardown whatever the test did (timeout included), and
 * `cic`: the subject whose browser talks to it, torn down by its fixture for
 * the same reason (a `finally` in the test body does not run on a timeout).
 * Its nick is named per run: NickServ keeps a registered nick for as long as
 * the testnet lives.
 */
export const test = base.extend<{ e2eBot: { start: typeof botStart }; cic: SpecSubject }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture-dependency declaration
  e2eBot: async ({}, use) => {
    await use({ start: botStart });
    await botStop(); // a no-op when no bot runs
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture-dependency declaration
  cic: async ({}, use, testInfo) => {
    const cic = await provisionPeerSubject(testInfo, `cic-${Date.now().toString(36)}`);
    await use(cic);
    await teardownSpecSubject(cic);
  },
});
