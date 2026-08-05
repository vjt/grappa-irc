// #806 — the instrument behind `IrcPeer.waitForPrivmsg`.
//
// This wait is how a routing regression (#373: grappa answers a DM to a
// renamed peer's STALE nick, upstream 401s, nothing is delivered) is
// judged, so it owes the reader evidence rather than a shrug. Three
// properties the plain `onceMatching` wait could not give:
//
//  1. The listener is attached BEFORE the trigger runs — a fast reply
//     cannot race it — while the deadline is clocked FROM the trigger.
//     The old shape welded the two to one instant, so whatever the
//     caller spent issuing the trigger came out of the delivery budget,
//     silently and unreported. Taking the trigger AS AN ARGUMENT is what
//     separates them without asking every caller to sequence it by hand:
//     the ordering is now structural, not a docstring the next spec
//     author has to obey.
//  2. Every privmsg seen during the wait is recorded — non-matching ones
//     included — and dumped on rejection. Measured on the #806 red runs:
//     the expected message arrived ~1ms and ~8ms PAST the deadline, and
//     the shipped error reported that identically to a total
//     non-delivery. A failure that cannot tell "the product is broken"
//     from "eight milliseconds late" is how a real regression gets
//     dismissed as a flake.
//  3. The handler is detached on EVERY exit path, timeout included.
//
// Deliberately free of `irc-framework` imports: `PrivmsgSource` is the
// two-method slice of its `Client` this needs, which keeps the one piece
// of the peer fixture carrying real logic unit-testable from the cic
// vitest project (which does not have the e2e-only dependency).

export type PrivmsgEvent = { nick: string; message: string };

export type PrivmsgSource = {
  on(event: "privmsg", handler: (event: PrivmsgEvent) => void): void;
  removeListener(event: "privmsg", handler: (event: PrivmsgEvent) => void): void;
};

export type PrivmsgWaitSpec = {
  fromNick: string;
  body: string;
  timeoutMs: number;
  // Issued once the listener is attached; the deadline starts when this
  // settles. Sync (`() => peer.privmsg(...)`) or async (`() =>
  // composeSend(page, body)`) — an async trigger is precisely the case
  // the old shape charged to the delivery budget.
  trigger: () => void | Promise<void>;
};

// Keep listening this long past the deadline before rejecting. It changes
// no verdict — a wait that blew its budget still fails — it only buys the
// message the ability to say LATE instead of SILENCE. That distinction is
// the difference between "delivery is slow" and "routing is broken", and
// on the runs that filed this issue it came down to one millisecond.
const LATE_ARRIVAL_GRACE_MS = 500;

const BODY_EXCERPT_CHARS = 120;

type SeenPrivmsg = { nick: string; message: string; at: number };

export async function awaitPrivmsg(source: PrivmsgSource, spec: PrivmsgWaitSpec): Promise<void> {
  const { fromNick, body, timeoutMs, trigger } = spec;
  const seen: SeenPrivmsg[] = [];
  // Re-based to the trigger below; until then the arm IS the zero, so a
  // reply that beats the trigger's return still gets a sane offset.
  let triggeredAt = Date.now();
  let expired = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  let resolveWait!: () => void;
  let rejectWait!: (error: Error) => void;
  const wait = new Promise<void>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });

  const matches = (event: PrivmsgEvent) =>
    event.nick === fromNick && event.message.includes(body);

  const handler = (event: PrivmsgEvent) => {
    const at = Date.now();
    seen.push({ nick: event.nick, message: event.message, at });
    if (!matches(event)) return;
    // Past the deadline this is the LATE case: it still fails, but it
    // fails saying the message WAS delivered.
    finish(expired ? new Error(failureMessage(spec, seen, triggeredAt, at)) : undefined);
  };

  // Detach + disarm without settling. Split out from `finish` so the
  // trigger-threw path can clean up and rethrow the caller's own error
  // rather than leaving `wait` rejected with nobody awaiting it.
  const cleanup = (): boolean => {
    if (settled) return false;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    source.removeListener("privmsg", handler);
    return true;
  };

  const finish = (error?: Error) => {
    if (!cleanup()) return;
    if (error) rejectWait(error);
    else resolveWait();
  };

  source.on("privmsg", handler);

  try {
    await trigger();
  } catch (triggerError) {
    cleanup();
    throw triggerError;
  }

  // The reply beat the trigger's return — nothing left to time.
  if (settled) return wait;

  triggeredAt = Date.now();
  timer = setTimeout(() => {
    expired = true;
    timer = setTimeout(
      () => finish(new Error(failureMessage(spec, seen, triggeredAt, undefined))),
      LATE_ARRIVAL_GRACE_MS,
    );
  }, timeoutMs);

  return wait;
}

function failureMessage(
  spec: PrivmsgWaitSpec,
  seen: SeenPrivmsg[],
  triggeredAt: number,
  lateArrivalAt: number | undefined,
): string {
  const { fromNick, body, timeoutMs } = spec;
  const offset = (at: number) => {
    const delta = at - triggeredAt;
    return `${delta >= 0 ? "+" : ""}${delta}ms`;
  };

  const lines = [
    `IrcPeer: no privmsg from "${fromNick}" containing "${body}" within ${timeoutMs}ms`,
    `  cause: ${cause(spec, seen, triggeredAt, lateArrivalAt)}`,
  ];
  if (seen.length > 0) {
    lines.push(`  seen (${seen.length} privmsg, offsets from the trigger):`);
    for (const entry of seen) {
      lines.push(`    ${offset(entry.at)} <${entry.nick}> "${excerpt(entry.message)}"`);
    }
  }
  return lines.join("\n");
}

function cause(
  spec: PrivmsgWaitSpec,
  seen: SeenPrivmsg[],
  triggeredAt: number,
  lateArrivalAt: number | undefined,
): string {
  const { fromNick, timeoutMs } = spec;
  if (lateArrivalAt !== undefined) {
    const late = lateArrivalAt - triggeredAt - timeoutMs;
    return `LATE — the expected message DID arrive, ${late}ms past the deadline: delivered, not lost`;
  }
  if (seen.length === 0) {
    return "SILENCE — no privmsg of any kind reached this peer during the wait";
  }
  const fromExpected = seen.filter((entry) => entry.nick === fromNick);
  if (fromExpected.length > 0) {
    return `WRONG BODY — ${fromExpected.length} privmsg from "${fromNick}", none containing the expected text`;
  }
  const senders = [...new Set(seen.map((entry) => entry.nick))];
  return `OTHER SENDERS — ${seen.length} privmsg arrived, none from "${fromNick}" (saw: ${senders.join(", ")})`;
}

function excerpt(message: string): string {
  return message.length <= BODY_EXCERPT_CHARS
    ? message
    : `${message.slice(0, BODY_EXCERPT_CHARS)}…`;
}
