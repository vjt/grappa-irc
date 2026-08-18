import { requestConfirm } from "../confirmDialog";
import { friendlyError } from "../friendlyError";
import { joinedChannelsOnNetwork } from "../joinedChannels";
import { sendFanOut } from "../sendPipeline";
import type { CommandHandler } from "./context";

// #431 — above this many channels an /ame|/amsg asks before it writes anything.
// A DECIDED number (vjt, 2026-08-09), not a tuned one: one keystroke that
// writes to N channels is a spam vector, and ten is where a fan-out stops
// reading as "the rooms I am in" and starts reading as a broadcast.
const FANOUT_CONFIRM_THRESHOLD = 10;

/**
 * #431 — /ame + /amsg: the same body to EVERY joined channel of THIS network.
 * Deliberately not addressed to the active window: the fan-out is per-NETWORK
 * (vjt 2026-08-09 — cross-network is out of scope, and no flag for it), so it
 * works from the $server window just as well as from a channel, and it
 * includes the window it was typed in.
 *
 * ONE handler for two kinds: the pair differ only by the ACTION framing, which
 * `cmd.kind` already decides, so splitting them would duplicate the confirm
 * gate and the partial-failure accounting.
 *
 * #1396 — it reaches the seam at zero new fields on the record. Everything it
 * needs beyond `ctx.key` and `ctx.networkSlug` is an ordinary module import,
 * which is what tells it apart from `privmsg`/`me`/`msg`: those close over the
 * composer's draft store (`sendPacedBody`), this one never touches the buffer.
 */
export const fanOutCommand: CommandHandler<"ame" | "amsg"> = async (cmd, ctx) => {
  const action = cmd.kind === "ame";
  // The joined-channel projection #30's channel tab-completion already reads:
  // server-owned, so `invited` (the window an unsolicited INVITE opens),
  // `pending`, `failed`, `kicked` and `parked` are all excluded by the same
  // `joined` predicate, and there is no parallel client-side channel list to
  // drift from it. Queries and $server cannot appear at all — `window_states`
  // is channel-keyed by construction on the server, a DM lives in
  // `queryWindows`.
  const targets = joinedChannelsOnNetwork(ctx.key).sort();
  if (targets.length === 0) {
    return { error: `/${cmd.kind}: no joined channel on ${ctx.networkSlug}` };
  }
  // Channels the fan-out has finished, for the "how far did it get" half of a
  // failure — the number that tells the operator whether retyping the line
  // would double-send it.
  let done = 0;
  const run = (): Promise<void> =>
    sendFanOut(ctx.networkSlug, targets, cmd.body, action, (n) => {
      done = n;
    });
  if (targets.length > FANOUT_CONFIRM_THRESHOLD) {
    // The question names every target, not just the count: the blast radius IS
    // the thing being consented to, so "11 channels" alone would be consent
    // without disclosure.
    requestConfirm({
      title: action ? "Send action to every channel" : "Send message to every channel",
      body: `Send to ${targets.length} channels on ${ctx.networkSlug}? ${targets.join(", ")}`,
      confirmLabel: "Send",
      // Detached: `requestConfirm` resolves nothing, so the send cannot be
      // awaited here and its failure cannot surface inline the way the
      // un-gated path's does below. Logged with a grep key instead, mirroring
      // `windowClose.disconnectNetwork` — the same shape of
      // destructive-action-behind-a-confirm. Never bare: an unhandled
      // rejection here would be a fan-out that stopped in silence.
      onConfirm: () => {
        void run().catch((err) => {
          console.warn(
            `[/${cmd.kind}] fan-out stopped after ${done} of ${targets.length} channels on ${ctx.networkSlug}:`,
            err,
          );
        });
      },
      alternative: null,
    });
    return { ok: `/${cmd.kind}: ${targets.length} channels — confirm to send` };
  }
  try {
    await run();
  } catch (e) {
    return {
      error: `${friendlyError(e)} — sent to ${done} of ${targets.length} channels`,
    };
  }
  return { ok: `/${cmd.kind}: sent to ${targets.join(", ")}` };
};
