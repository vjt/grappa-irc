// #1513 — the send pipeline, lifted out of `compose.ts`.
//
// `compose.ts` imports `commands/*`, so anything a command handler must reach
// cannot live in `compose.ts` without closing an import cycle. Everything here
// was module-scope in `compose.ts` and depends only on leaves (`messageLines`,
// `ctcpAction`) plus the transport — never on the composer store — so it moves
// whole rather than in pieces.
//
// The same move, for the same reason, as #1192 taking `ctcpFrame` out to
// `ctcpAction.ts`: "dispatch without importing `compose`".
//
// `draftLines` and `wireBody` travel WITH the cluster and not to a leaf of
// their own: all three of their call sites use them as a PAIR (the plan, the
// door, and #1108's preview), and that pairing is the invariant that keeps the
// operator's frame count produced by the code that does the sending.

import { ApiError } from "./apiError";
import { ctcpFrame, scrubCtcpDelimiters } from "./ctcpAction";
import { splitMessageLines } from "./messageLines";
import { sendMessage as sendWindowMessage } from "./scrollback";

// The lines a free-text body fans out to — one PRIVMSG each, after the exit
// scrub. Shared by the send path and #1108's pre-send preview so the count
// the operator reads is produced by the code that does the sending.
export const draftLines = (body: string): string[] => splitMessageLines(scrubCtcpDelimiters(body));

// The exact bytes ONE of those lines becomes on the wire: `/me` wraps every
// line in its own CTCP ACTION envelope, and that envelope is charged against
// the frame budget on every fragment the server splits it into.
export const wireBody = (line: string, action: boolean): string =>
  action ? ctcpFrame("ACTION", line) : line;

// #666 — resumable, self-pacing multiline fan-out.
//
// A paste sends one PRIVMSG per line, but the server's send door (the
// per-(subject, network) token bucket, #340) refuses a burst past its
// capacity with a 429. Pre-#666 the first 429 rejected the for-await loop and
// EVERY remaining line was silently dropped, while the draft (cleared only on
// success) still held the WHOLE body — so resending duplicated the delivered
// lines AND immediately re-tripped the throttle. The fix makes a 429 a pause,
// not a failure: wait the server's retry-after, then retry THIS line (a
// refused line was never delivered, so retrying is neither a drop nor a dup).
// Only a fatal error stops the drain.

// Fallback wait when a 429 arrives with no parseable retry-after (the server
// always sends one now — messages_controller/#666 — but a proxy could strip
// the header). Matches the send throttle's default 0.5/s refill (1 token / 2s).
const DEFAULT_RETRY_AFTER_MS = 2_000;

// Upper clamp on a server-supplied retry-after. grappa emits 2s; the clamp is
// purely defensive so a hostile/misconfigured intermediary can't inject a huge
// `retry-after` and freeze the composer (the retry cap bounds the COUNT of
// waits, this bounds their DURATION).
const MAX_RETRY_AFTER_MS = 60_000;

// Safety valve: how many times ONE send is re-paced against a persistent 429
// before the fan-out gives up and surfaces the throttle. An honest send door
// admits on the FIRST retry once a token has refilled (we waited its own
// retry-after), so the cap is only reached by a door that refuses PAST its own
// hint (a misbehaving/severed server, or a proxy 429) — the guard that keeps
// the composer from hanging on an unbounded retry loop. Generous enough to
// absorb timer jitter around the refill boundary.
const MAX_PACED_RETRIES_PER_SEND = 5;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// A send-door 429 — the ONLY error class the fan-out paces-and-retries rather
// than surfacing. Everything else (WS down, invalid_line, a severed-session
// 401) is fatal and stops the drain.
const isSendThrottled = (e: unknown): e is ApiError => e instanceof ApiError && e.status === 429;

// ms to wait before retrying a throttled line. `api.ts readError` parses the
// server's `retry-after` header (seconds) into `info.retry_after`; convert to
// ms, falling back to the send-throttle default if it's missing/garbage.
const retryAfterMs = (e: ApiError): number => {
  const seconds = e.info.retry_after;
  const ms =
    typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
      ? seconds * 1_000
      : DEFAULT_RETRY_AFTER_MS;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
};

// One outbound PRIVMSG: which target, which line of the body. The line is held
// UNFRAMED (the CTCP wrap happens at the door) so the residue callback can hand
// the operator back what they typed rather than what went on the wire.
type PacedSend = { target: string; line: string };

// Expand a body into the ordered send plan for `targets`, TARGET-MAJOR: every
// line of the body for the first target, then every line for the second, and so
// on. One target is the #666 single-window case (a paste = one PRIVMSG per
// line, see messageLines.ts for the wire-framing why); N targets is the #431
// /ame|/amsg fan-out. Building ONE flat plan rather than nesting a per-target
// drain inside a per-line one is what keeps the retry safe: a paced retry
// re-sends exactly one (target, line), never a target whose earlier lines
// already landed.
//
// The lines come from `draftLines`, which owns the #1126 exit scrub, and each
// one is framed at the door by `wireBody` — so a plan holds what the operator
// typed and the drain turns it into wire bytes.
const planSends = (targets: readonly string[], body: string): PacedSend[] => {
  const lines = draftLines(body);
  return targets.flatMap((target) => lines.map((line) => ({ target, line })));
};

// #666/#431 — THE paced drain, shared by both fan-outs that can burst the send
// door. Sends `plan` in order, sequential await so wire order is preserved.
// `action` wraps every line in CTCP ACTION framing (via the shared `ctcpFrame`
// builder) for /me and /ame.
//
// A send-door 429 is a PAUSE, not a failure: wait the server's own retry-after,
// then retry THE SAME entry — `sent` never advances past a refusal, so the
// drain neither drops an entry nor duplicates a delivered one. Any other error
// (WS down, invalid_line, a severed-session 401) stops it and propagates.
// Pacing engages only for a plan of MORE than one send: a lone throttled send
// surfaces immediately, preserving #342's throttle-copy affordance.
//
// #431 — why honouring the server's hint IS the pacing an /ame fan-out needs,
// rather than a guessed inter-message sleep. The door is the #340
// per-(subject, network) token bucket (capacity 5, refill 0.5/s), and it is
// deliberately tuned to refuse BEFORE the ircd's flood protection kills the
// connection (`messages_controller.take_send_token`, whose moduledoc says so).
// The retry-after it hands back is that bucket's own refill interval, so
// waiting it paces against the thing that actually decides. A constant here
// would be a second, unmeasured opinion about the same limit, free to drift
// from it the moment the bucket is retuned.
//
// `onProgress` fires after every acked send AND before every pace/stop, with
// the count acked so far.
const drainPaced = async (
  plan: readonly PacedSend[],
  slug: string,
  action: boolean,
  onProgress: (sent: number) => void,
): Promise<void> => {
  const total = plan.length;
  let sent = 0;
  // Consecutive paced retries of the CURRENT entry; reset when `sent` advances.
  let retries = 0;
  while (sent < total) {
    // `??` satisfies noUncheckedIndexedAccess; `sent < total` guarantees a value.
    const { target, line } = plan[sent] ?? { target: "", line: "" };
    try {
      await sendWindowMessage(slug, target, wireBody(line, action));
      sent += 1;
      retries = 0;
      onProgress(sent);
    } catch (e) {
      onProgress(sent);
      if (isSendThrottled(e) && total > 1 && retries < MAX_PACED_RETRIES_PER_SEND) {
        retries += 1;
        await sleep(retryAfterMs(e));
        // loop retries the same `sent` index — never advanced past a refusal.
      } else {
        throw e;
      }
    }
  }
};

// Send a free-text body to ONE target, one PRIVMSG per line, paced. Shared by
// the privmsg, me, and msg send sites — the only free-text paths whose body can
// contain an operator-typed newline. External callers (ServiceModal,
// RegistrationWizardModal) pass no callback and simply inherit the never-drop +
// pacing behaviour.
//
// `onProgress` reports the count sent so far and the unsent remainder joined
// back into a body — compose `submit` mirrors that remainder into the draft so
// it holds ONLY what has not gone out. The residue always starts at `sent`, the
// first line NOT yet acked: on a 429 that is the refused line (about to be
// retried), on a fatal error the line that failed (kept, not dropped).
export const sendBodyLines = async (
  slug: string,
  target: string,
  body: string,
  action: boolean,
  onProgress?: (sent: number, total: number, residue: string) => void,
): Promise<void> => {
  const plan = planSends([target], body);
  await drainPaced(plan, slug, action, (sent) =>
    onProgress?.(
      sent,
      plan.length,
      plan
        .slice(sent)
        .map((p) => p.line)
        .join("\n"),
    ),
  );
};

// #431 — /ame + /amsg: one copy of the body to EVERY target, through the same
// paced door. `onProgress` reports completed CHANNELS rather than sends, so a
// fatal stop can tell the operator how far the fan-out actually got — the count
// they need to decide whether to retype it.
export const sendFanOut = async (
  slug: string,
  targets: readonly string[],
  body: string,
  action: boolean,
  onProgress: (channelsDone: number) => void,
): Promise<void> => {
  const plan = planSends(targets, body);
  // Target-major and every target carries the same lines, so the plan divides
  // evenly and a completed channel is a whole run of `perTarget` acks. Never a
  // division by zero: an empty plan means the loop below never runs, so
  // `onProgress` is never called.
  const perTarget = plan.length / targets.length;
  await drainPaced(plan, slug, action, (sent) => onProgress(Math.floor(sent / perTarget)));
};
