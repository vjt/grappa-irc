// #348 — "is <nick> away RIGHT NOW", as one correlated WHOIS round-trip.
//
// WHOIS is request/response and always ends in `318 RPL_ENDOFWHOIS`, so a
// reply that completes WITHOUT a `301 RPL_AWAY` is a POSITIVE statement of
// "present". Watching the line stream for a 301 instead cannot say that: it
// only ever reports "I heard nothing", which is equally what a peer killed
// by bahamut's per-IP limits, a reply stuck behind the fake-lag bank, and a
// nick that never registered all produce. A spec asserting "still not away"
// over a window is otherwise satisfied by silence — so silence must not be
// able to be a verdict.
//
// Both failure modes REJECT rather than resolving false, because "not away"
// is precisely the wrong thing to tell a caller here:
//   * no 318 inside the budget — the peer asked and nobody answered;
//   * `401 ERR_NOSUCHNICK` — nobody by that nick is on the network (e.g. the
//     bouncer registered a suffixed nick after a collision), so the reply
//     says nothing about the session under test.
//
// Lives in its own module, free of the e2e-only `irc-framework` dependency
// and reached through a structural source, for the reason `privmsgWait.ts`
// gives: the instrument a claim is judged by has to be provable itself, and
// that means unit-testable under the cic vitest project without a testnet.

export type RawLineEvent = { line: string; from_server: boolean };

export type WhoisSource = {
  on(event: "raw", handler: (event: RawLineEvent) => void): unknown;
  removeListener(event: "raw", handler: (event: RawLineEvent) => void): unknown;
  raw(parts: string[]): void;
};

export type WhoisAwayOptions = {
  nick: string;
  timeoutMs: number;
};

/** One WHOIS round-trip, asking whether its replies about `nick` carry `numeric` (issue 2430: a 307 says the nick is registered). */
export type WhoisNumericOptions = WhoisAwayOptions & { numeric: string };

// The numeric of a WHOIS reply line that is ABOUT `nick`, or null.
//
// Server numerics are `:<prefix> <numeric> <requester> <subject> …`, so the
// subject is read off field 3 rather than regex-matched anywhere in the line:
// a 301's away message is FREE TEXT and can hold a nick, a numeric, or both,
// and a spec whose oracle can be flipped by what somebody typed after `/away`
// is not an oracle. Nick comparison is exact `===`, the convention every
// other predicate in `ircClient.ts` already uses (`event.nick === this.nick`)
// — bahamut is CASEMAPPING=ascii and echoes the nick as it holds it, and a
// spelling that somehow differed surfaces as a LOUD unanswered-WHOIS rather
// than as a quiet wrong answer.
export function whoisNumericFor(line: string, nick: string): string | null {
  const parts = line.split(" ");
  if (parts.length < 4) return null;
  return parts[3] === nick ? parts[1] : null;
}

export function awaitWhoisAway(source: WhoisSource, opts: WhoisAwayOptions): Promise<boolean> {
  return awaitWhoisNumeric(source, { ...opts, numeric: "301" });
}

// Whether the WHOIS replies about `nick` carry `numeric` before their 318:
// the shape above, for any one reply.
export function awaitWhoisNumeric(
  source: WhoisSource,
  opts: WhoisNumericOptions,
): Promise<boolean> {
  const { nick, numeric, timeoutMs } = opts;

  return new Promise((resolve, reject) => {
    let saw = false;

    const settle = (finish: () => void) => {
      clearTimeout(timer);
      source.removeListener("raw", handler);
      finish();
    };

    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            `whois ${numeric}: no 318 RPL_ENDOFWHOIS for ${nick} within ${timeoutMs}ms — ` +
              `the WHOIS went unanswered, so whether it carries a ${numeric} is unknown, not false`,
          ),
        ),
      );
    }, timeoutMs);

    const handler = (event: RawLineEvent) => {
      if (!event.from_server) return;
      const got = whoisNumericFor(event.line, nick);
      if (got === numeric) {
        saw = true;
        return;
      }
      switch (got) {
        case "401":
          settle(() =>
            reject(
              new Error(
                `whois ${numeric}: 401 ERR_NOSUCHNICK for ${nick} — nobody by that nick is on ` +
                  `the network, so this WHOIS says nothing about the session under test`,
              ),
            ),
          );
          return;
        case "318":
          settle(() => resolve(saw));
          return;
        default:
      }
    };

    source.on("raw", handler);
    source.raw(["WHOIS", nick]);
  });
}
