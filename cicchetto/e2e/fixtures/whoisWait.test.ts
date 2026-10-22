// #348 — the away oracle is the instrument three negative assertions are
// judged by, so it has to be evidence rather than a shrug. These run under
// the cic vitest project (see vitest.config.ts) because the wait is
// deliberately free of the e2e-only `irc-framework` dependency — same
// reason, same shape as `privmsgWait.test.ts`.
//
// The cases that matter are the ones where the OLD stream-watching oracle
// answered "not away" for the wrong reason: nobody answered at all, the
// nick is not on the network, or the 301 belonged to somebody else.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitWhoisAway,
  awaitWhoisNumeric,
  type RawLineEvent,
  type WhoisSource,
} from "./whoisWait";

type FakeSource = WhoisSource & {
  server: (line: string) => void;
  own: (line: string) => void;
  attached: () => number;
  sent: () => string[][];
};

function fakeSource(): FakeSource {
  const handlers = new Set<(event: RawLineEvent) => void>();
  const sent: string[][] = [];
  return {
    on: (_event, handler) => {
      handlers.add(handler);
    },
    removeListener: (_event, handler) => {
      handlers.delete(handler);
    },
    raw: (parts) => {
      sent.push(parts);
    },
    server: (line) => {
      for (const handler of [...handlers]) handler({ line, from_server: true });
    },
    own: (line) => {
      for (const handler of [...handlers]) handler({ line, from_server: false });
    },
    attached: () => handlers.size,
    sent: () => sent,
  };
}

async function failureOf(wait: Promise<boolean>): Promise<string> {
  try {
    await wait;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected the round-trip to reject, but it resolved");
}

const NICK = "s1a2b3c4";
const END = `:leaf4.azzurra.chat 318 i348-away-watcher ${NICK} :End of /WHOIS list.`;
const AWAY = `:leaf4.azzurra.chat 301 i348-away-watcher ${NICK} :auto-away`;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("awaitWhoisAway", () => {
  it("asks: it puts the WHOIS on the wire, or nothing would ever answer", () => {
    const source = fakeSource();
    void awaitWhoisAway(source, { nick: NICK, timeoutMs: 1_000 }).catch(() => {});
    expect(source.sent()).toEqual([["WHOIS", NICK]]);
  });

  it("is away when a 301 precedes the 318", async () => {
    const source = fakeSource();
    const wait = awaitWhoisAway(source, { nick: NICK, timeoutMs: 1_000 });
    source.server(AWAY);
    source.server(END);
    await expect(wait).resolves.toBe(true);
  });

  it("is present when the round-trip completes with no 301 — an answer, not a silence", async () => {
    const source = fakeSource();
    const wait = awaitWhoisAway(source, { nick: NICK, timeoutMs: 1_000 });
    source.server(`:leaf4.azzurra.chat 311 i348-away-watcher ${NICK} u h * :real name`);
    source.server(END);
    await expect(wait).resolves.toBe(false);
  });

  it("rejects when nobody answers: silence is not a verdict of present", async () => {
    const source = fakeSource();
    // The rejection handler is attached BEFORE the clock is advanced: a
    // rejection that lands with nothing listening is an unhandled rejection,
    // which vitest fails the RUN over while every test still reports green.
    const failure = failureOf(awaitWhoisAway(source, { nick: NICK, timeoutMs: 1_000 }));
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await failure).toContain("no 318 RPL_ENDOFWHOIS");
  });

  it("rejects on 401: a nick that is not on the network says nothing about the session", async () => {
    const source = fakeSource();
    const wait = awaitWhoisAway(source, { nick: NICK, timeoutMs: 1_000 });
    source.server(`:leaf4.azzurra.chat 401 i348-away-watcher ${NICK} :No such nick/channel`);
    expect(await failureOf(wait)).toContain("401 ERR_NOSUCHNICK");
  });

  it("ignores a 301 about somebody else", async () => {
    const source = fakeSource();
    const wait = awaitWhoisAway(source, { nick: NICK, timeoutMs: 1_000 });
    source.server(":leaf4.azzurra.chat 301 i348-away-watcher someone-else :away");
    source.server(END);
    await expect(wait).resolves.toBe(false);
  });

  // The sharp case, and the reason the subject is read off field 3 rather
  // than looked for anywhere in the line: this IS a 301, and our nick IS in
  // it — in somebody else's away text, where a person may well put it.
  // Matching on "the line mentions the nick" reports away for a user who is
  // present, which is the one wrong answer the negative assertions cannot
  // survive.
  it("ignores a 301 about somebody else whose away text names our nick", async () => {
    const source = fakeSource();
    const wait = awaitWhoisAway(source, { nick: NICK, timeoutMs: 1_000 });
    source.server(
      `:leaf4.azzurra.chat 301 i348-away-watcher someone-else :back later, ask ${NICK}`,
    );
    source.server(END);
    await expect(wait).resolves.toBe(false);
  });

  it("ignores our own outbound frames", async () => {
    const source = fakeSource();
    const wait = awaitWhoisAway(source, { nick: NICK, timeoutMs: 1_000 });
    // `raw` fires for both directions; a 301-shaped line we SENT is not the
    // network telling us anything.
    source.own(AWAY);
    source.server(END);
    await expect(wait).resolves.toBe(false);
  });

  it("detaches its listener on every branch, so a peer does not accumulate handlers", async () => {
    const answered = fakeSource();
    const wait = awaitWhoisAway(answered, { nick: NICK, timeoutMs: 1_000 });
    expect(answered.attached()).toBe(1);
    answered.server(END);
    await wait;
    expect(answered.attached()).toBe(0);

    const silent = fakeSource();
    const timedOut = failureOf(awaitWhoisAway(silent, { nick: NICK, timeoutMs: 1_000 }));
    expect(silent.attached()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_001);
    await timedOut;
    expect(silent.attached()).toBe(0);
  });
});

// issue 2430 — the same round-trip for another reply: a 307 says the nick is
// registered with NickServ, which is what the bot's trust layer reads.
describe("awaitWhoisNumeric", () => {
  const REGISTERED = `:leaf4.azzurra.chat 307 i2430-witness ${NICK} :has identified for this nick`;

  it("is true when the asked numeric precedes the 318, false when the 318 comes alone", async () => {
    const yes = fakeSource();
    const registered = awaitWhoisNumeric(yes, { nick: NICK, numeric: "307", timeoutMs: 1_000 });
    yes.server(REGISTERED);
    yes.server(END);
    expect(await registered).toBe(true);

    const no = fakeSource();
    const unregistered = awaitWhoisNumeric(no, { nick: NICK, numeric: "307", timeoutMs: 1_000 });
    no.server(AWAY);
    no.server(END);
    expect(await unregistered).toBe(false);
  });

  it("rejects on 401, naming the numeric it was asked for", async () => {
    const source = fakeSource();
    const wait = awaitWhoisNumeric(source, { nick: NICK, numeric: "307", timeoutMs: 1_000 });
    source.server(`:leaf4.azzurra.chat 401 i2430-witness ${NICK} :No such nick/channel`);
    expect(await failureOf(wait)).toContain("whois 307: 401 ERR_NOSUCHNICK");
  });
});
