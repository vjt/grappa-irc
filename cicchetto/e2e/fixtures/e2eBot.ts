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

/** The bot, stopped in teardown whatever the test did (timeout included). */
export const test = base.extend<{ e2eBot: { start: typeof botStart } }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture-dependency declaration
  e2eBot: async ({}, use) => {
    await use({ start: botStart });
    await botStop(); // a no-op when no bot runs
  },
});
